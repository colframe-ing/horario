// ============================================================
// FACTURACIÓN — los tres tableros (PLAN_FACTURACION.md §4)
// ============================================================
//
// 4.1  Salió y nadie lo facturó   — remisiones firmes sin factura, por antigüedad
// 4.2  Se facturó y no ha salido  — el "expuesto" de cada cotización
// 4.3  Aprobado contra facturado  — el corte de dinero
//
// Todo sale de UNA llamada (`factura_tablero`): los tres cortes vienen de las
// mismas lecturas de hoja, así que pedirlos por separado triplicaría el costo
// para pintar una sola pantalla.
(function () {
  'use strict';

  var session = getSession();
  if (!session || !session.token) { location.href = 'index.html'; return; }
  // Solo admin: esta pantalla muestra precios, márgenes y cobros.
  if (!session.esAdmin) { location.href = 'produccion.html'; return; }
  var token = session.token;

  var _datos = null;

  // ── Utilidades ───────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, tipo) {
    var cont = document.getElementById('toastContainer');
    var el = document.createElement('div');
    var bg = tipo === 'error' ? '#DC2626' : (tipo === 'ok' ? '#16A34A' : '#071D49');
    el.style.cssText = 'pointer-events:auto;background:' + bg + ';color:#fff;padding:10px 16px;border-radius:10px;' +
      'font-size:0.82rem;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,0.2);max-width:340px;';
    el.textContent = msg;
    cont.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3200);
    setTimeout(function () { el.remove(); }, 3600);
  }
  function manejarError(e) {
    if (e && e.tipo === 'auth') { clearSession(); location.href = 'index.html'; return; }
    toast((e && e.message) ? e.message : 'Ocurrió un error', 'error');
  }
  function money(n) {
    if (n == null || n === '' || isNaN(Number(n))) return '—';
    var v = Number(n);
    // El signo va ANTES del símbolo: "-$275.434", no "$-275.434". El único
    // número negativo de esta pantalla es una factura repartida de más, que es
    // justo el que hay que poder leer de un vistazo sin dudar.
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('es-CO', { maximumFractionDigits: 0 });
  }
  function num(n, dec) {
    if (n == null || n === '' || isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('es-CO', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
  }

  // ── Orden de los identificadores ─────────────────────────────────────────
  //
  // RM-0250, FE322, CB581.1: todos mezclan letras con números, y una
  // comparación de cadenas los ordena mal en cuanto los dígitos no están
  // rellenados con ceros. `FE1000` va ANTES que `FE322` alfabéticamente, porque
  // compara el '1' contra el '3' y ahí se acabó.
  //
  // Los consecutivos de remisión sí vienen con ceros (`remFormatearConsecutivo`
  // los rellena a cuatro), así que para ellos la cadena bastaría — pero eso es
  // una propiedad del formato que nadie prometió mantener, y depender de ella
  // obliga a recordar cuál de los tres identificadores está rellenado. Un solo
  // comparador para los tres: los tramos de dígitos se comparan como NÚMEROS y
  // el resto como texto.
  function _trozos(s) {
    return String(s == null ? '' : s).toUpperCase().match(/\d+|\D+/g) || [];
  }
  function cmpRef(a, b) {
    var ta = _trozos(a), tb = _trozos(b);
    var n = Math.max(ta.length, tb.length);
    for (var i = 0; i < n; i++) {
      var x = ta[i], y = tb[i];
      if (x === undefined) return -1;          // el más corto va primero: FE32 < FE322
      if (y === undefined) return 1;
      var numX = /^\d/.test(x), numY = /^\d/.test(y);
      if (numX && numY) {
        var d = parseInt(x, 10) - parseInt(y, 10);
        if (d) return d < 0 ? -1 : 1;
      } else if (x !== y) {
        return x < y ? -1 : 1;
      }
    }
    return 0;
  }
  /** Comparador por un campo de identificación.
   *
   *  Las filas SIN identificador van PRIMERO, no al final. Una remisión firme
   *  sin consecutivo existe —`BORRADOR → DESPACHADA` es una transición válida y
   *  solo `remConciliar` asigna número— y es en sí misma algo que hay que
   *  mirar: mandarla al fondo de una lista larga es esconderla. */
  function porRef(campo, desc) {
    return function (a, b) {
      var va = String(a[campo] == null ? '' : a[campo]).trim();
      var vb = String(b[campo] == null ? '' : b[campo]).trim();
      if (!va && !vb) return 0;
      if (!va) return -1;
      if (!vb) return 1;
      return desc ? cmpRef(vb, va) : cmpRef(va, vb);
    };
  }
  /** La referencia de una cotización, como texto ordenable: 581.1, 1024.2. */
  function refCotiz(c) {
    var cb = String(c.cb == null ? '' : c.cb).trim();
    if (!cb || cb === '0') return '';
    var v = String(c.version == null ? '' : c.version).trim();
    return v ? cb + '.' + v : cb;
  }

  // ── Estado de carga ──────────────────────────────────────────────────────
  //
  // `factura_tablero` recorre las hojas de remisiones, detalle, asignaciones,
  // facturas, la cola de producción y el maestro de cotizaciones. En un Sheet
  // con datos reales eso son varios segundos, y hasta ahora la pantalla se
  // quedaba en blanco todo ese rato: no se distinguía "está trabajando" de
  // "cargó y no hay nada", que son cosas muy distintas cuando lo que buscas es
  // plata sin cobrar.
  // Los cinco contenedores que llena `factura_tablero`, y por eso los cinco que
  // tienen que decir que están esperando. Van juntos en una lista y no repetidos
  // en cada función: la respuesta es UNA sola llamada, así que o cargan todos o
  // no carga ninguno, y separarlos invitaría a olvidar uno al agregar el sexto.
  var CAJAS = ['cortes', 'sinFacturar', 'porCotizacion', 'facturadas', 'facturas'];

  /** Pinta `html` en las cinco cajas. El spinner usa la clase `.fact-cargando`
   *  de la hoja de estilos, la misma que trae el HTML de arranque, para que no
   *  haya dos definiciones del mismo estado. */
  function enTodasLasCajas(html) {
    CAJAS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = html;
    });
  }

  function pintarCargando() {
    enTodasLasCajas('<div class="fact-cargando"><span class="spinner"></span></div>');
  }

  // ── Cortes de arriba ─────────────────────────────────────────────────────
  function pintarCortes(t, nSinFacturar) {
    var html = '';
    html += corte('aprobado', 'Aprobado', money(t.valorAprobado), 'de las cotizaciones aprobadas');
    html += corte('facturado', 'Facturado', money(t.facturado),
                  t.aiu > 0 ? ('incluye ' + money(t.aiu) + ' de AIU') : 'sin AIU registrado');
    html += corte('pendiente', 'Por facturar', money(t.pendiente),
                  t.facturadoDeMas > 0 ? ('⚠ ' + money(t.facturadoDeMas) + ' cobrado de más') : 'lo que falta cobrar');
    html += corte('expuesto', 'Cobrado sin salir', money(t.expuesto), 'anticipos y actas de obra');
    html += corte('', 'Sin facturar', String(nSinFacturar),
                  nSinFacturar === 1 ? 'remisión despachada' : 'remisiones despachadas');
    document.getElementById('cortes').innerHTML = html;
  }
  function corte(cls, lbl, val, sub) {
    return '<div class="corte ' + cls + '">' +
      '<div class="lbl">' + esc(lbl) + '</div>' +
      '<div class="val">' + esc(val) + '</div>' +
      '<div class="sub">' + esc(sub) + '</div></div>';
  }

  // ── 4.1 ──────────────────────────────────────────────────────────────────
  function pintarSinFacturar(lista) {
    var cont = document.getElementById('sinFacturar');
    if (!lista.length) {
      cont.innerHTML = '<div class="vacio">Nada pendiente: todo lo que salió está facturado.</div>';
      return;
    }
    // Por consecutivo, no por fecha. El backend las entrega de la más vieja a la
    // más nueva y ese orden no se pierde: el consecutivo se asigna al conciliar,
    // así que crece con el tiempo. Lo que se gana es poder buscar una remisión
    // concreta en la lista, que es lo que uno hace teniendo el papel en la mano.
    // La antigüedad sigue a la vista en la columna de días, con su marca en rojo
    // a los 30 — el dato no dependía del orden.
    var filas = lista.slice().sort(porRef('consecutivo')).map(function (r) {
      // Sin fecha no se puede envejecer, pero la fila sigue siendo plata sin
      // cobrar: se muestra igual, marcada, en vez de esconderla por estar mal.
      var dias = r.dias == null
        ? '<span class="chip dias">sin fecha</span>'
        : '<span class="chip dias' + (r.dias >= 30 ? ' viejo' : '') + '">' + r.dias + ' d</span>';
      var rot = r.consecutivo || '(sin consecutivo)';
      return '<tr>' +
        '<td class="sel"><input type="checkbox" data-sel="' + esc(r.docId) + '" ' +
          'data-rot="' + esc(rot) + '"' + (r.docId ? '' : ' disabled') + '></td>' +
        '<td><span class="proy">' + esc(rot) + '</span>' +
          (r.proyecto ? '<div class="cbv">' + esc(r.proyecto) + '</div>' : '') + '</td>' +
        '<td>' + esc(r.fecha || '—') + '</td>' +
        '<td>' + dias + '</td>' +
        '<td>' + esc(r.estado || '') + '</td>' +
        '<td><button class="btn-mini" data-facturar="' + esc(r.docId) + '" ' +
          'data-rot="' + esc(rot) + '"' + (r.docId ? '' : ' disabled') + '>Registrar factura</button></td>' +
      '</tr>';
    }).join('');
    cont.innerHTML =
      '<div style="overflow-x:auto;"><table class="fact-table">' +
      '<thead><tr><th class="sel"><input type="checkbox" id="selTodas" ' +
        'title="Marcar todas"></th>' +
      '<th>Remisión</th><th>Fecha</th><th>Antigüedad</th><th>Estado</th><th></th></tr></thead>' +
      '<tbody>' + filas + '</tbody></table></div>';
    // La selección no sobrevive al repintado, y no hace falta que sobreviva: las
    // que se acaban de registrar ya no están en esta lista.
    actualizarBarraSel();
  }

  /** Los docId marcados, con su rótulo. */
  function seleccionadas() {
    return Array.prototype.filter.call(
      document.querySelectorAll('#sinFacturar [data-sel]'), function (c) { return c.checked; }
    ).map(function (c) {
      return { docId: c.getAttribute('data-sel'), rotulo: c.getAttribute('data-rot') };
    });
  }

  /** La barra de "registrar en las N marcadas". Aparece solo cuando hay algo
   *  marcado: una barra permanente en cero es ruido en una pantalla que ya
   *  tiene cuatro tablas. */
  function actualizarBarraSel() {
    var barra = document.getElementById('barraSel');
    if (!barra) return;
    var sel = seleccionadas();
    if (!sel.length) { barra.className = 'fact-barra hidden'; barra.innerHTML = ''; return; }
    barra.className = 'fact-barra';
    barra.innerHTML =
      '<span class="cuenta">' + sel.length + ' remisi' + (sel.length === 1 ? 'ón marcada' : 'ones marcadas') + '</span>' +
      '<button class="btn-mini" id="btnFactLote">Registrar una factura en ' +
        (sel.length === 1 ? 'ella' : 'las ' + sel.length) + '</button>' +
      '<button class="btn-mini" id="btnLimpiarSel">Quitar la marca</button>';
    document.getElementById('btnFactLote').onclick = function () { abrirFacturarRemision(sel); };
    document.getElementById('btnLimpiarSel').onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('#sinFacturar [data-sel]'),
        function (c) { c.checked = false; });
      var todas = document.getElementById('selTodas');
      if (todas) todas.checked = false;
      actualizarBarraSel();
    };
  }

  // ── 4.2 + 4.3 ────────────────────────────────────────────────────────────
  function pintarCotizaciones(lista, tot) {
    var cont = document.getElementById('porCotizacion');
    if (!lista.length) {
      cont.innerHTML = '<div class="vacio">No hay cotizaciones aprobadas con movimiento.</div>';
      return;
    }
    // Por consecutivo de cotización. El backend las recorre en el orden en que
    // están en la hoja de la cola, que no es ningún orden: es el de inserción.
    var filas = lista.slice().sort(function (a, b) {
      var ra = refCotiz(a), rb = refCotiz(b);
      if (!ra && !rb) return String(a.proyecto || '').localeCompare(String(b.proyecto || ''));
      if (!ra) return -1;
      if (!rb) return 1;
      return cmpRef(ra, rb);
    }).map(function (c) {
      var r = c.resumen;
      // El AIU mixto se marca, no se corrige: si en la misma cotización unas
      // facturas lo cobran y otras no, la comparación deja de ser limpia y eso
      // hay que verlo. Estimar el faltante sería inventar un cobro.
      var chips = '';
      if (r.aiuMixto)   chips += ' <span class="chip aiu" title="Unas facturas de esta cotización cobran AIU y otras no">AIU mixto</span>';
      if (r.expuesto > 0) chips += ' <span class="chip exp" title="Cobrado y todavía sin salir de la planta">expuesto</span>';
      var pend = r.facturadoDeMas > 0
        ? '<span class="mal">+' + money(r.facturadoDeMas) + '</span>'
        : (r.pendiente > 0 ? '<span class="neg">' + money(r.pendiente) + '</span>'
                           : '<span class="ok">—</span>');
      return '<tr>' +
        '<td><span class="proy">' + esc(c.proyecto || c.archivo) + '</span>' + chips +
          '<div class="cbv">CB' + esc(c.cb) + (c.version ? '.' + esc(c.version) : '') +
          ' · ' + esc(c.estado) + '</div></td>' +
        '<td>' + money(r.valorAprobado) + '</td>' +
        '<td>' + money(r.facturado) + (r.aiu > 0 ? '<div class="cbv">AIU ' + money(r.aiu) + '</div>' : '') + '</td>' +
        '<td>' + pend + '</td>' +
        '<td>' + (r.expuesto > 0 ? '<span class="neg">' + money(r.expuesto) + '</span>' : '—') + '</td>' +
        '<td>' + num(r.unidadesDespachadas) + '/' + num(r.unidades) + '</td>' +
        '<td><button class="btn-mini" data-asignar="' + esc(c.archivo) + '" ' +
          'data-proy="' + esc(c.proyecto || c.archivo) + '">Asignar</button></td>' +
      '</tr>';
    }).join('');
    cont.innerHTML =
      '<div style="overflow-x:auto;"><table class="fact-table">' +
      '<thead><tr><th>Proyecto</th><th>Aprobado</th><th>Facturado</th><th>Por facturar</th>' +
      '<th>Expuesto</th><th>Despachado</th><th></th></tr></thead>' +
      '<tbody>' + filas + '</tbody>' +
      '<tfoot><tr><td>Total</td><td>' + money(tot.valorAprobado) + '</td>' +
      '<td>' + money(tot.facturado) + '</td>' +
      '<td>' + (tot.facturadoDeMas > 0 ? '<span class="mal">+' + money(tot.facturadoDeMas) + '</span> / ' : '') +
        money(tot.pendiente) + '</td>' +
      '<td>' + money(tot.expuesto) + '</td><td></td><td></td></tr></tfoot>' +
      '</table></div>' +
      (tot.conAiuMixto ? '<p class="sec-sub" style="margin-top:10px;">⚠ ' + tot.conAiuMixto +
        ' cotización(es) con AIU mixto: unas facturas lo cobran y otras no.</p>' : '');
  }

  // ── Deshacer: las últimas facturadas ─────────────────────────────────────
  function pintarFacturadas(lista) {
    var cont = document.getElementById('facturadas');
    if (!lista.length) {
      cont.innerHTML = '<div class="vacio">Todavía no se ha registrado ninguna factura.</div>';
      return;
    }
    // Esta va al REVÉS que las demás, y es la única: de mayor a menor
    // consecutivo. La tabla existe para deshacer una factura recién registrada
    // —registrarla congela la remisión, así que es la única salida de un dígito
    // mal tecleado— y ponerla en orden ascendente entierra en la mitad de la
    // lista justo lo que se acaba de hacer. Sigue estando ordenada; lo que
    // cambia es por cuál punta se empieza.
    var filas = lista.slice().sort(porRef('consecutivo', true)).map(function (r) {
      return '<tr>' +
        '<td><span class="proy">' + esc(r.consecutivo || '(sin consecutivo)') + '</span>' +
          (r.proyecto ? '<div class="cbv">' + esc(r.proyecto) + '</div>' : '') + '</td>' +
        '<td>' + esc(r.facturaNumero) + '</td>' +
        '<td>' + esc(r.fecha || '—') + '</td>' +
        '<td><button class="btn-mini" data-quitar="' + esc(r.docId) + '" ' +
          'data-rot="' + esc(r.consecutivo) + '" data-fact="' + esc(r.facturaNumero) + '"' +
          (r.docId ? '' : ' disabled') + '>Quitar factura</button></td>' +
      '</tr>';
    }).join('');
    cont.innerHTML =
      '<div style="overflow-x:auto;"><table class="fact-table">' +
      '<thead><tr><th>Remisión</th><th>Factura</th><th>Fecha</th><th></th></tr></thead>' +
      '<tbody>' + filas + '</tbody></table></div>';
  }

  // ── Facturas con saldo ───────────────────────────────────────────────────
  function pintarFacturas(lista, total) {
    var cont = document.getElementById('facturas');
    if (!lista.length) {
      cont.innerHTML = '<div class="vacio">' +
        (total ? 'Las ' + total + ' facturas del maestro están repartidas.'
               : 'El maestro de facturas está vacío. Corre <code>factImportarFacturas()</code> o el .bat de sync.') +
        '</div>';
      return;
    }
    // Por número de factura. El backend las ordena por saldo descendente, que
    // responde "¿cuál es la más grande sin repartir?" — pero la pregunta real
    // al llegar aquí es "¿dónde está la FE322?", con la factura delante. El
    // saldo sigue en su columna y el signo lo marca en rojo, así que lo urgente
    // no se pierde por no estar arriba.
    var filas = lista.slice().sort(porRef('numero')).map(function (f) {
      // Un saldo negativo es que se repartió MÁS de lo que la factura vale. Se
      // muestra en rojo y con signo: redondearlo a cero lo escondería.
      var neg = f.sinAsignar < 0;
      return '<tr>' +
        '<td><span class="proy">' + esc(f.numero) + '</span>' +
          (f.cotizaciones.length ? '<div class="cbv">' + f.cotizaciones.length + ' cotización(es)</div>' : '') + '</td>' +
        '<td>' + money(f.subtotal) + '</td>' +
        '<td>' + money(f.asignado) + '</td>' +
        '<td>' + (neg ? '<span class="mal">' + money(f.sinAsignar) + '</span>'
                      : '<span class="neg">' + money(f.sinAsignar) + '</span>') + '</td>' +
        '<td><button class="btn-mini" data-sug="' + esc(f.numero) + '">Sugerencias</button></td>' +
      '</tr>';
    }).join('');
    cont.innerHTML =
      '<div style="overflow-x:auto;"><table class="fact-table">' +
      '<thead><tr><th>Factura</th><th>Subtotal</th><th>Asignado</th><th>Sin repartir</th><th></th></tr></thead>' +
      '<tbody>' + filas + '</tbody></table></div>';
  }

  // ── Modales ──────────────────────────────────────────────────────────────
  function cerrarModal() { document.getElementById('modalCont').innerHTML = ''; }

  function modal(html) {
    document.getElementById('modalCont').innerHTML =
      '<div class="modal-back" id="modalBack"><div class="modal-box">' + html + '</div></div>';
    document.getElementById('modalBack').addEventListener('click', function (e) {
      if (e.target.id === 'modalBack') cerrarModal();
    });
  }

  /** Pide un motivo. El backend lo EXIGE tanto para quitar una factura como
   *  para anular una asignación, y con razón: sin motivo, después hay que
   *  adivinar si fue un error de digitación o una nota crédito, que son cosas
   *  muy distintas. Devuelve el texto, o null si se canceló. */
  function pedirMotivo(titulo, detalle, btnOk) {
    return new Promise(function (resolve) {
      modal(
        '<h4>' + esc(titulo) + '</h4>' +
        '<p class="hint">' + esc(detalle) + '</p>' +
        '<div class="campo"><label>Motivo</label>' +
          '<input id="mMotivo" maxlength="300" placeholder="número mal digitado, nota crédito…" autocomplete="off">' +
          '<div class="ayuda">Queda en la auditoría junto a quién lo hizo y cuándo.</div>' +
        '</div>' +
        '<div class="modal-acciones">' +
          '<button class="btn btn-sm" id="mCancel">Cancelar</button>' +
          '<button class="btn btn-sm btn-primary" id="mOk">' + esc(btnOk) + '</button>' +
        '</div>');
      document.getElementById('mMotivo').focus();
      document.getElementById('mCancel').onclick = function () { cerrarModal(); resolve(null); };
      document.getElementById('mOk').onclick = function () {
        var v = document.getElementById('mMotivo').value.trim();
        if (!v) { toast('Escribe por qué', 'error'); return; }
        cerrarModal(); resolve(v);
      };
    });
  }

  function quitarFactura(docId, rotulo, factura) {
    pedirMotivo('Quitar la factura ' + factura,
                rotulo + ' — la remisión vuelve a DESPACHADA y podrá editarse otra vez.',
                'Quitar').then(function (motivo) {
      if (!motivo) return;
      return apiRemisionDesfacturar(token, docId, motivo).then(function () {
        toast('Factura quitada. La remisión volvió a la lista de pendientes.', 'ok');
        return cargar(true);
      });
    }).catch(manejarError);
  }

  function anularAsignacion(asigId, etiqueta, archivo, proyecto) {
    pedirMotivo('Anular la asignación', etiqueta, 'Anular').then(function (motivo) {
      if (!motivo) return;
      return apiFacturaAsignacionAnular(token, asigId, motivo).then(function () {
        toast('Asignación anulada', 'ok');
        cerrarModal();
        // El modal se reabre YA, sin esperar al tablero. Antes se recargaba todo
        // primero y solo después volvías a donde estabas: pagabas los siete
        // barridos de hoja para regresar al mismo sitio. El historial del modal
        // es una llamada aparte y mucho más barata, y es justo el dato que
        // acaba de cambiar; el tablero se pone al día por detrás.
        abrirAsignar(archivo, proyecto);
        return cargar(true);
      });
    }).catch(manejarError);
  }

  /** Lo ya asignado a esta cotización, con su salida. Se pide al abrir el modal
   *  y no viene en el tablero a propósito: el tablero muestra decenas de
   *  cotizaciones y el detalle solo hace falta en la que se está mirando. */
  function historialHtml(r) {
    var asigs = (r && r.asignaciones) || [];
    if (!asigs.length) return '';
    // Por número de factura, con la fecha de asignación como desempate: una
    // misma factura puede aparecer dos veces —anulada y vuelta a asignar— y esas
    // dos tienen que quedar juntas y en el orden en que pasaron.
    var filas = asigs.slice().sort(function (a, b) {
      var d = cmpRef(a.facturaNumero, b.facturaNumero);
      return d || String(a.asignadoTs || '').localeCompare(String(b.asignadoTs || ''));
    }).map(function (a) {
      var anulada = !!String(a.anuladoTs || '').trim();
      var monto = money((Number(a.monto) || 0) + (Number(a.montoAiu) || 0));
      var etiqueta = a.facturaNumero + ' por ' + monto;
      return '<tr' + (anulada ? ' style="opacity:.55;"' : '') + '>' +
        '<td>' + esc(a.facturaNumero) +
          (a.montoAiu > 0 ? '<div class="cbv">AIU ' + money(a.montoAiu) + '</div>' : '') + '</td>' +
        '<td>' + (anulada ? '<s>' + monto + '</s>' : monto) + '</td>' +
        '<td>' + (anulada
          ? '<span class="cbv">anulada</span>'
          : '<button class="btn-mini" data-anular="' + esc(a.asigId) + '" ' +
            'data-etq="' + esc(etiqueta) + '" data-arch="' + esc(a.cotizacionArchivo) + '" ' +
            'data-proy="' + esc(r.proyecto || '') + '">Anular</button>') + '</td>' +
      '</tr>';
    }).join('');
    return '<div class="campo"><label>Ya asignado</label>' +
      '<table class="fact-table" style="font-size:0.76rem;">' +
      '<tbody>' + filas + '</tbody></table>' +
      '<div class="ayuda">Anular no borra la fila: la marca, y queda el rastro de quién y por qué.</div>' +
    '</div>';
  }

  // ── Sugerencias desde las notas de la factura ────────────────────────────
  //
  // PROPONE, NO ASIGNA. Cada propuesta se confirma una por una: el matcher lee
  // lo que alguien escribió en las notas de la factura, y eso alcanza para
  // servir el trabajo, no para reemplazar el criterio de quien cobra.
  //
  // UNA FACTURA SE REPARTE ENTRE VARIOS CB, y ese es el caso normal: FE322
  // cubre tres proyectos. Antes, aplicar una propuesta cerraba el modal,
  // recargaba el tablero entero y te devolvía al principio — para la segunda
  // había que volver a buscar la factura y volver a pedir sus sugerencias. Tres
  // recargas completas para repartir una factura.
  //
  // Ahora el modal VUELVE: al terminar una asignación se reabre con las
  // sugerencias recién consultadas, o sea que la que acabas de aplicar aparece
  // ya como "asignada" y las que faltan siguen ahí. El tablero se recarga UNA
  // vez, al cerrar, y solo si hubo algún cambio.
  //
  // Se vuelve a preguntar al backend en vez de tachar la propuesta en memoria:
  // `factSugerencias` recalcula `yaAsignadas` contra la hoja, así que el estado
  // que se ve es el real y no una copia que hay que mantener en sincronía.
  function abrirSugerencias(numero, sesion) {
    var s = sesion || { aplicadas: 0 };

    // Al cerrar: una sola recarga, y solo si de verdad se escribió algo.
    var cerrar = function () {
      cerrarModal();
      if (s.aplicadas > 0) cargar(true);
    };

    modal('<h4>Sugerencias para ' + esc(numero) + '</h4>' +
          '<p class="hint">Leyendo las notas de la factura…</p>');
    apiFacturaSugerencias(token, numero).then(function (r) {
      var html = '<h4>Sugerencias para ' + esc(numero) + '</h4>';
      if (s.aplicadas > 0) {
        html += '<div class="aviso info">Llevas <strong>' + s.aplicadas + '</strong> asignación(es) ' +
                'en esta factura. Las que ya quedaron aparecen abajo como asignadas; ' +
                'el tablero se actualiza al cerrar.</div>';
      }
      html += '<p class="hint">' + (r.nota
        ? 'Notas de la factura: “' + esc(r.nota) + '”'
        : 'Esta factura no trae notas.') + '</p>';

      if (!r.propuestas.length && !r.sinResolver.length) {
        // Es el caso NORMAL: la mayoría de las facturas no trae referencia
        // porque el cliente exige poner otra cosa ahí. No es un fallo.
        html += '<div class="aviso info">No encontré ninguna referencia a cotización en las notas. ' +
                'Hay que asignarla a mano desde el tablero de arriba.</div>';
      }

      if (r.propuestas.length) {
        html += '<div class="campo"><label>Se puede asignar</label><table class="fact-table" style="font-size:0.78rem;"><tbody>' +
          r.propuestas.map(function (p, i) {
            return '<tr>' +
              '<td><span class="proy">' + esc(p.proyecto || p.cotizacionArchivo) + '</span>' +
                '<div class="cbv">CB' + esc(p.cb) + (p.version ? '.' + esc(p.version) : '') +
                (p.confianza === 'OTRA_VERSION'
                  ? ' · <span class="chip aiu">la nota cita otra versión</span>' : '') +
                '</div>' +
                // La descripción de la línea es lo que permite verificar contra
                // el PDF antes de confirmar. Y si el nombre de la nota no
                // aparece en ella se dice: en FE322 la nota escribe "SAN
                // FRANCISCO" y la línea "SAN FRANCISO", un typo de la factura.
                (p.lineaDescripcion
                  ? '<div class="cbv">línea ' + esc(p.linea) + ': ' + esc(p.lineaDescripcion) + '</div>' +
                    (p.nombreCoincide === false
                      ? '<div class="cbv" style="color:#B45309;">⚠ el nombre de la nota no aparece en la línea — verifica</div>'
                      : '')
                  : '') +
                '</td>' +
              '<td>' + (p.monto ? money(p.monto) : '<span class="cbv">monto a mano</span>') +
                (p.kgFacturado ? '<div class="cbv">' + num(p.kgFacturado) + ' kg</div>' : '') + '</td>' +
              '<td><button class="btn-mini" data-aplicar="' + i + '">Asignar</button></td>' +
            '</tr>';
          }).join('') + '</tbody></table>' +
          (r.pareoPorLinea
            ? '<div class="ayuda">El monto y los kg salen de las líneas de la factura — es el reparto que hizo ' +
              'quien facturó, no una estimación. Verifícalo contra el PDF antes de confirmar.</div>'
            : (r.propuestas.some(function (p) { return !p.monto; })
              ? '<div class="ayuda">El monto va a mano: esta factura no tiene sus líneas guardadas, o no hay una ' +
                'por cada referencia. Repartir en partes iguales sería inventar cifras.</div>'
              : '')) +
        '</div>';
      }

      if (r.sinResolver.length) {
        html += '<div class="campo"><label>Reconocidas, pero no se pueden asignar</label>' +
          '<table class="fact-table" style="font-size:0.78rem;"><tbody>' +
          r.sinResolver.map(function (s) {
            return '<tr><td>' + esc(s.ref.texto || (s.ref.tipo + s.ref.cb)) + '</td>' +
                   '<td style="text-align:left;" class="cbv">' + esc(s.detalle) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }

      html += '<div class="modal-acciones"><button class="btn btn-sm" id="sCerrar">' +
              (s.aplicadas > 0 ? 'Listo' : 'Cerrar') + '</button></div>';
      document.getElementById('modalCont').querySelector('.modal-box').innerHTML = html;
      document.getElementById('sCerrar').onclick = cerrar;

      // Aplicar una propuesta: abre el modal de asignar con todo prellenado.
      // No se escribe desde aquí — se pasa por el mismo formulario de siempre,
      // que es donde se ve el monto y el AIU antes de confirmar.
      //
      // El cuarto argumento es lo que hace posible repartir sin salir: en vez de
      // recargar el tablero al terminar, vuelve a estas sugerencias.
      Array.prototype.forEach.call(document.querySelectorAll('[data-aplicar]'), function (b) {
        b.onclick = function () {
          var p = r.propuestas[parseInt(b.getAttribute('data-aplicar'), 10)];
          cerrarModal();
          abrirAsignar(p.cotizacionArchivo, p.proyecto || p.cotizacionArchivo,
                       { factura: numero, monto: p.monto, kg: p.kgFacturado },
                       function () { s.aplicadas++; abrirSugerencias(numero, s); });
        };
      });
    }).catch(function (e) { cerrar(); manejarError(e); });
  }

  function abrirAsignar(archivo, proyecto, previo, alTerminar) {
    var opciones = (_datos.facturasConSaldo || []).map(function (f) {
      return '<option value="' + esc(f.numero) + '" data-saldo="' + f.sinAsignar + '">' +
             esc(f.numero) + ' — sin repartir ' + money(f.sinAsignar) + '</option>';
    }).join('');
    // Se pinta primero sin historial y se rellena al llegar: abrir el modal no
    // puede quedarse esperando una llamada. Pero se dice que viene en camino —
    // sin eso, el hueco donde va "Ya asignado" es idéntico al de una cotización
    // que no tiene nada asignado, y ahí es donde alguien asigna dos veces la
    // misma factura por no haber esperado medio segundo.
    pintarAsignar(archivo, proyecto, opciones,
      '<div class="campo"><label>Ya asignado</label>' +
      '<div class="ayuda">Consultando lo que ya se le asignó a esta cotización…</div></div>',
      alTerminar);
    // Prellenado desde una sugerencia. Se rellena y no se envía: quien cobra
    // tiene que ver el monto y decidir el AIU antes de confirmar.
    if (previo) {
      if (previo.factura) document.getElementById('aNumero').value = previo.factura;
      if (previo.monto)   document.getElementById('aMonto').value = previo.monto;
      if (previo.kg)      document.getElementById('aKg').value = previo.kg;
      document.getElementById(previo.monto ? 'aAiu' : 'aMonto').focus();
    }
    apiFacturaCotizacion(token, archivo).then(function (r) {
      var caja = document.getElementById('aHistorial');
      if (caja) caja.innerHTML = historialHtml(Object.assign({ proyecto: proyecto }, r));
    }).catch(function () { /* sin historial se puede asignar igual */ });
  }

  function pintarAsignar(archivo, proyecto, opciones, historial, alTerminar) {
    modal(
      '<h4>Asignar factura</h4>' +
      '<p class="hint">' + esc(proyecto) + '</p>' +
      '<div id="aHistorial">' + historial + '</div>' +
      '<div class="campo"><label>Factura</label>' +
        '<input id="aNumero" list="aLista" placeholder="FE322" autocomplete="off">' +
        '<datalist id="aLista">' + opciones + '</datalist>' +
        '<div class="ayuda">Si todavía no está en el maestro se registra igual, pero el saldo no se puede verificar.</div>' +
      '</div>' +
      '<div class="campo"><label>Monto sin AIU</label>' +
        '<input id="aMonto" type="number" step="0.01" min="0" placeholder="0">' +
      '</div>' +
      '<div class="campo"><label>AIU</label>' +
        '<input id="aAiu" type="number" step="0.01" min="0" placeholder="0">' +
        '<div class="ayuda">Déjalo en cero si esta factura no cobró AIU. Se compara contra el aprobado sumando los dos, porque el subtotal de la cotización ya lo incluye.</div>' +
      '</div>' +
      '<div class="campo"><label>Kg facturados (opcional)</label>' +
        '<input id="aKg" type="number" step="0.01" min="0" placeholder="0">' +
      '</div>' +
      '<div class="campo"><label>Nota (opcional)</label>' +
        '<input id="aNota" maxlength="300" placeholder="acta de obra 1, anticipo…">' +
      '</div>' +
      '<div class="modal-acciones">' +
        '<button class="btn btn-sm" id="aCancel">Cancelar</button>' +
        '<button class="btn btn-sm btn-primary" id="aOk">Asignar</button>' +
      '</div>');

    document.getElementById('aCancel').onclick = cerrarModal;
    document.getElementById('aOk').onclick = function () {
      var numero = document.getElementById('aNumero').value.trim();
      var monto  = parseFloat(document.getElementById('aMonto').value) || 0;
      var aiu    = parseFloat(document.getElementById('aAiu').value) || 0;
      var kg     = parseFloat(document.getElementById('aKg').value) || 0;
      var nota   = document.getElementById('aNota').value.trim();
      if (!numero) { toast('Escribe el número de factura', 'error'); return; }
      if (monto + aiu <= 0) { toast('El monto tiene que ser mayor a cero (el AIU cuenta)', 'error'); return; }
      // El botón se deshabilita para que un doble clic no mande dos veces la
      // misma asignación, y se vuelve a habilitar SIEMPRE en el `finally`.
      //
      // Sin eso, un rechazo del backend dejaba el formulario lleno y el botón
      // muerto: había que cancelar y volver a teclear número, monto, AIU y kg.
      // Y es justo donde más pasa —"esta factura ya está asignada a esta
      // cotización, anúlala si el monto cambió"— o sea que se explicaba cómo
      // corregir y al mismo tiempo se quitaba la forma de hacerlo.
      //
      // En el camino feliz `cerrarModal()` ya sacó el botón del DOM; ponerle
      // `disabled` a un nodo suelto no hace nada y no hay que distinguir casos.
      var btn = this;
      btn.disabled = true;
      apiFacturaAsignar(token, numero, archivo, monto, aiu, kg, 'MANUAL', nota)
        .then(function (r) {
          cerrarModal();
          if (r.facturaConocida === false) {
            toast('Asignada. Ojo: ' + numero + ' todavía no está en el maestro de facturas.', 'info');
          } else if (r.saldo && r.saldo.sinAsignar < -0.5) {
            toast('Asignada, pero ' + numero + ' quedó repartida de más: ' + money(r.saldo.sinAsignar), 'error');
          } else {
            toast('Factura asignada', 'ok');
          }
          // Si vengo del flujo de sugerencias, vuelvo allá en vez de recargar:
          // la factura casi siempre tiene otro CB esperando, y recargar aquí
          // sería pagar el tablero entero para volver a abrir lo mismo.
          if (alTerminar) return alTerminar(r);
          return cargar(true);
        })
        .catch(manejarError)
        .finally(function () { btn.disabled = false; });
    };
  }

  // "Registrar factura" y no "Facturar": esto NO emite nada en Dataico. Anota
  // el número de una factura que YA existe. El verbo importa — "Facturar"
  // sugiere emitir, que es un acto legal ante la DIAN (genera CUFE, se firma,
  // se transmite, y solo se deshace con nota crédito). Ningún botón de este
  // sistema hace eso, y el nombre no puede insinuar que sí.
  //
  // Tampoco "Conciliar": esa palabra ya es la compuerta maker-checker de la
  // remisión —el botón "✓ Conciliar y despachar", el estado POR_CONCILIAR, el
  // evento REMISION_CONCILIADA—, que consume el consecutivo y mueve el libro de
  // inventario. Dos botones "Conciliar" en la vida de la misma remisión, y dos
  // eventos de auditoría que se leen igual, sería peor que el nombre impreciso.
  //
  // RECIBE UNA LISTA, no un documento. Una factura cubre VARIAS remisiones —lo
  // dice el propio modelo: `Remisiones.facturaNumero` es una columna, y por eso
  // no hizo falta tabla puente de este lado— pero la pantalla obligaba a
  // registrarla de a una, con su modal y su recarga completa cada vez. Cinco
  // remisiones de la misma factura eran cinco vueltas.
  //
  // El botón de cada fila manda una sola; la barra de selección manda las
  // marcadas. Es el mismo camino, así que no hay dos formas de registrar una
  // factura que puedan divergir.
  function abrirFacturarRemision(docs) {
    var lista = [].concat(docs);
    if (!lista.length) return;
    var varias = lista.length > 1;

    modal(
      '<h4>Registrar factura</h4>' +
      '<p class="hint">' + (varias
        ? lista.length + ' remisiones — todas quedan con el mismo número'
        : esc(lista[0].rotulo)) + '</p>' +
      (varias
        ? '<div class="campo"><label>Se le pondrá a</label>' +
          '<div style="max-height:120px;overflow:auto;">' +
          lista.map(function (d) {
            return '<div class="lote-fila"><span>' + esc(d.rotulo) + '</span></div>';
          }).join('') + '</div></div>'
        : '') +
      '<div class="aviso info">Esto <strong>no emite nada en Dataico</strong>: anota el número de una ' +
        'factura que ya existe, para dejar constancia de que ' +
        (varias ? 'esas remisiones quedaron cobradas' : 'esta remisión quedó cobrada') + '.</div>' +
      '<div class="aviso warn">Al registrarla, ' +
        (varias ? 'las ' + lista.length + ' remisiones quedan <strong>congeladas</strong>'
                : 'la remisión queda <strong>congelada</strong>') +
        ': no se les podrán cambiar ítems ni cantidades, ni siquiera siendo admin. Si el número ' +
        'queda mal, se les quita la factura y se vuelve a hacer.</div>' +
      '<div class="campo"><label>Número de factura</label>' +
        '<input id="fNumero" placeholder="FE322" autocomplete="off"></div>' +
      '<div class="campo"><label>Fecha (opcional)</label>' +
        '<input id="fFecha" type="date"></div>' +
      '<div class="campo"><label>CUFE (opcional)</label>' +
        '<input id="fCufe" maxlength="120" placeholder="…"></div>' +
      '<div id="fProgreso" class="ayuda" style="min-height:14px;"></div>' +
      '<div class="modal-acciones">' +
        '<button class="btn btn-sm" id="fCancel">Cancelar</button>' +
        '<button class="btn btn-sm btn-primary" id="fOk">Registrar</button>' +
      '</div>');

    document.getElementById('fCancel').onclick = cerrarModal;
    document.getElementById('fOk').onclick = function () {
      var numero = document.getElementById('fNumero').value.trim();
      if (!numero) { toast('Escribe el número de factura', 'error'); return; }
      var fecha = document.getElementById('fFecha').value || '';
      var cufe  = document.getElementById('fCufe').value.trim();
      // Mismo criterio que en `pintarAsignar`: se bloquea contra el doble clic y
      // se libera en el `finally`. Acá pesa aún más, porque el rechazo típico
      // —"esta remisión ya está facturada con FE322: si el número está mal,
      // quítale la factura primero"— es una instrucción que hay que poder
      // seguir sin volver a abrir el modal.
      var btn = this;
      btn.disabled = true;
      var prog = document.getElementById('fProgreso');
      var hechas = [];

      // UNA POR UNA, no en paralelo. `remFacturar` toma el script lock de Apps
      // Script, así que lanzarlas juntas no las hace concurrentes: las pone a
      // esperarse entre ellas, con el riesgo de que alguna agote los 15 s del
      // `waitLock` y falle por congestión y no por su propio motivo.
      var cadena = Promise.resolve();
      lista.forEach(function (d, i) {
        cadena = cadena.then(function () {
          if (prog) prog.textContent = 'Registrando ' + (i + 1) + ' de ' + lista.length +
                                       ': ' + d.rotulo + '…';
          return apiRemisionFacturar(token, d.docId, numero, fecha, cufe)
            .then(function (r) { hechas.push({ d: d, ok: true, sinCambio: !!r.sinCambio }); })
            .catch(function (e) {
              // Una que falle NO aborta las demás: si la tercera ya estaba
              // facturada con otro número, la cuarta y la quinta siguen siendo
              // trabajo legítimo. Lo que pasó con cada una se reporta abajo.
              //
              // La excepción es la sesión: si se venció, las que quedan van a
              // fallar todas igual, así que se corta y se deja que el manejador
              // haga lo suyo.
              if (e && e.tipo === 'auth') throw e;
              hechas.push({ d: d, ok: false, msg: (e && e.message) || 'falló' });
            });
        });
      });

      cadena.then(function () {
        var bien = hechas.filter(function (h) { return h.ok; });
        var mal  = hechas.filter(function (h) { return !h.ok; });
        if (!mal.length) {
          cerrarModal();
          toast(bien.length === 1
            ? (bien[0].sinCambio ? 'Ya tenía registrada esa factura' : 'Factura registrada')
            : 'Factura registrada en ' + bien.length + ' remisiones', 'ok');
          return cargar(true);
        }
        // Con fallos el modal NO se cierra: el resumen de qué entró y qué no es
        // justo lo que hay que leer, y un toast de tres segundos no alcanza
        // para cinco líneas.
        if (prog) {
          prog.innerHTML = hechas.map(function (h) {
            return '<div class="lote-fila"><span>' + esc(h.d.rotulo) + '</span>' +
                   (h.ok ? '<span class="bien">registrada</span>'
                         : '<span class="falla">' + esc(h.msg) + '</span>') + '</div>';
          }).join('');
        }
        toast(bien.length + ' registrada(s), ' + mal.length + ' sin registrar', 'error');
        // Se recarga igual: las que sí entraron ya cambiaron el tablero.
        if (bien.length) cargar(true);
      })
      .catch(manejarError)
      .finally(function () { btn.disabled = false; });
    };
  }

  // ── Carga ────────────────────────────────────────────────────────────────
  //
  // DOS MODOS, y la diferencia es de dónde viene la llamada.
  //
  // La PRIMERA carga no tiene nada que mostrar, así que los spinners son la
  // respuesta correcta. Un refresco DESPUÉS de escribir sí tiene: la tabla que
  // ya estás mirando. Borrarla para poner cinco spinners durante los tres o
  // cuatro segundos que tarda `factura_tablero` —siete barridos de hoja en tres
  // spreadsheets— convierte cada asignación en un parpadeo de la pantalla
  // entera. Y como una factura se reparte entre varios proyectos, ese parpadeo
  // se paga tres o cuatro veces seguidas por factura.
  //
  // En modo silencioso los datos viejos se quedan en su sitio y se cambian
  // cuando llega el reemplazo. Lo único que aparece es la barra de estado.
  function estado(clase, html) {
    var el = document.getElementById('estadoCarga');
    if (!el) return;
    if (!clase) { el.className = 'fact-estado hidden'; el.innerHTML = ''; return; }
    el.className = 'fact-estado ' + clase;
    el.innerHTML = html;
  }

  function cargar(silencioso) {
    if (silencioso) estado('trabajando', '<span class="spinner"></span> Actualizando los números…');
    else pintarCargando();

    return apiFacturaTablero(token).then(function (r) {
      _datos = r;
      pintarCortes(r.totales || {}, (r.sinFacturar || []).length);
      pintarSinFacturar(r.sinFacturar || []);
      pintarFacturadas(r.facturadas || []);
      pintarCotizaciones(r.cotizaciones || [], r.totales || {});
      pintarFacturas(r.facturasConSaldo || [], r.facturasTotal || 0);
      estado(null);
    }).catch(function (e) {
      var msg = (e && e.message) ? e.message : 'No se pudo cargar';
      if (silencioso) {
        // NO se borra lo que hay: la escritura sí funcionó, lo que falló fue
        // volver a leer. Pero lo que quedó en pantalla es de ANTES de esa
        // escritura, o sea que está mal y tiene cara de estar bien. El toast se
        // va a los tres segundos; este aviso se queda hasta el próximo refresco.
        estado('viejo', '⚠ Se guardó, pero no se pudieron releer los números: ' + esc(msg) +
                        ' — lo que ves es de antes de ese cambio.');
      } else {
        // Primera carga: no hay datos viejos que conservar, y dejar los cinco
        // spinners girando diría "estoy trabajando" cuando ya se rindió.
        enTodasLasCajas('<div class="vacio" style="grid-column:1/-1;">' + esc(msg) + '</div>');
        estado(null);
      }
      manejarError(e);
    });
  }

  // Delegación: las tablas se repintan enteras en cada carga, así que enganchar
  // los botones uno por uno los dejaría muertos tras el primer refresco.
  document.addEventListener('click', function (e) {
    var bA = e.target.closest ? e.target.closest('[data-asignar]') : null;
    if (bA) { abrirAsignar(bA.getAttribute('data-asignar'), bA.getAttribute('data-proy')); return; }
    var bF = e.target.closest ? e.target.closest('[data-facturar]') : null;
    if (bF) {
      // El botón de la fila es el caso de una sola: mismo camino que el lote,
      // con una lista de un elemento.
      abrirFacturarRemision([{ docId: bF.getAttribute('data-facturar'),
                               rotulo: bF.getAttribute('data-rot') }]);
      return;
    }
    var bQ = e.target.closest ? e.target.closest('[data-quitar]') : null;
    if (bQ) { quitarFactura(bQ.getAttribute('data-quitar'), bQ.getAttribute('data-rot'),
                            bQ.getAttribute('data-fact')); return; }
    var bS = e.target.closest ? e.target.closest('[data-sug]') : null;
    if (bS) { abrirSugerencias(bS.getAttribute('data-sug')); return; }
    var bN = e.target.closest ? e.target.closest('[data-anular]') : null;
    if (bN) { anularAsignacion(bN.getAttribute('data-anular'), bN.getAttribute('data-etq'),
                               bN.getAttribute('data-arch'), bN.getAttribute('data-proy')); return; }
  });

  // Las casillas también van por delegación, por lo mismo que los botones: la
  // tabla se repinta entera en cada carga.
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.id === 'selTodas') {
      // "Marcar todas" marca solo las marcables: una remisión firme sin docId
      // no se puede facturar y su casilla está deshabilitada.
      Array.prototype.forEach.call(document.querySelectorAll('#sinFacturar [data-sel]'),
        function (c) { if (!c.disabled) c.checked = t.checked; });
      actualizarBarraSel();
      return;
    }
    if (t.hasAttribute('data-sel')) {
      var todas = document.getElementById('selTodas');
      if (todas) {
        var cajas = Array.prototype.slice.call(
          document.querySelectorAll('#sinFacturar [data-sel]:not([disabled])'));
        todas.checked = cajas.length > 0 && cajas.every(function (c) { return c.checked; });
      }
      actualizarBarraSel();
    }
  });

  // `clearSession()` ya borra la fila de sesión en el servidor además del
  // localStorage (api.js), que es lo que cerró R2-08. Por eso no hay una
  // llamada extra aquí: sería la misma dos veces.
  document.getElementById('logoutBtn').addEventListener('click', function () {
    clearSession(); location.href = 'index.html';
  });

  document.getElementById('modNav').classList.remove('hidden');
  cargar();
})();
