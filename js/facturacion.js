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
    var filas = lista.map(function (r) {
      // Sin fecha no se puede envejecer, pero la fila sigue siendo plata sin
      // cobrar: se muestra igual, marcada, en vez de esconderla por estar mal.
      var dias = r.dias == null
        ? '<span class="chip dias">sin fecha</span>'
        : '<span class="chip dias' + (r.dias >= 30 ? ' viejo' : '') + '">' + r.dias + ' d</span>';
      return '<tr>' +
        '<td><span class="proy">' + esc(r.consecutivo || '(sin consecutivo)') + '</span>' +
          (r.proyecto ? '<div class="cbv">' + esc(r.proyecto) + '</div>' : '') + '</td>' +
        '<td>' + esc(r.fecha || '—') + '</td>' +
        '<td>' + dias + '</td>' +
        '<td>' + esc(r.estado || '') + '</td>' +
        '<td><button class="btn-mini" data-facturar="' + esc(r.docId) + '" ' +
          'data-rot="' + esc(r.consecutivo) + '"' + (r.docId ? '' : ' disabled') + '>Facturar</button></td>' +
      '</tr>';
    }).join('');
    cont.innerHTML =
      '<div style="overflow-x:auto;"><table class="fact-table">' +
      '<thead><tr><th>Remisión</th><th>Fecha</th><th>Antigüedad</th><th>Estado</th><th></th></tr></thead>' +
      '<tbody>' + filas + '</tbody></table></div>';
  }

  // ── 4.2 + 4.3 ────────────────────────────────────────────────────────────
  function pintarCotizaciones(lista, tot) {
    var cont = document.getElementById('porCotizacion');
    if (!lista.length) {
      cont.innerHTML = '<div class="vacio">No hay cotizaciones aprobadas con movimiento.</div>';
      return;
    }
    var filas = lista.map(function (c) {
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
    var filas = lista.map(function (f) {
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
      '</tr>';
    }).join('');
    cont.innerHTML =
      '<div style="overflow-x:auto;"><table class="fact-table">' +
      '<thead><tr><th>Factura</th><th>Subtotal</th><th>Asignado</th><th>Sin repartir</th></tr></thead>' +
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

  function abrirAsignar(archivo, proyecto) {
    var opciones = (_datos.facturasConSaldo || []).map(function (f) {
      return '<option value="' + esc(f.numero) + '" data-saldo="' + f.sinAsignar + '">' +
             esc(f.numero) + ' — sin repartir ' + money(f.sinAsignar) + '</option>';
    }).join('');
    modal(
      '<h4>Asignar factura</h4>' +
      '<p class="hint">' + esc(proyecto) + '</p>' +
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
      this.disabled = true;
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
          return cargar();
        })
        .catch(manejarError);
    };
  }

  function abrirFacturarRemision(docId, rotulo) {
    modal(
      '<h4>Facturar remisión</h4>' +
      '<p class="hint">' + esc(rotulo) + '</p>' +
      '<div class="aviso warn">Al facturarla queda <strong>congelada</strong>: no se le podrán cambiar ítems ni ' +
        'cantidades, ni siquiera siendo admin. Si el número queda mal, se le quita la factura y se vuelve a hacer.</div>' +
      '<div class="campo"><label>Número de factura</label>' +
        '<input id="fNumero" placeholder="FE322" autocomplete="off"></div>' +
      '<div class="campo"><label>Fecha (opcional)</label>' +
        '<input id="fFecha" type="date"></div>' +
      '<div class="campo"><label>CUFE (opcional)</label>' +
        '<input id="fCufe" maxlength="120" placeholder="…"></div>' +
      '<div class="modal-acciones">' +
        '<button class="btn btn-sm" id="fCancel">Cancelar</button>' +
        '<button class="btn btn-sm btn-primary" id="fOk">Facturar</button>' +
      '</div>');

    document.getElementById('fCancel').onclick = cerrarModal;
    document.getElementById('fOk').onclick = function () {
      var numero = document.getElementById('fNumero').value.trim();
      if (!numero) { toast('Escribe el número de factura', 'error'); return; }
      this.disabled = true;
      apiRemisionFacturar(token, docId,
                          numero,
                          document.getElementById('fFecha').value || '',
                          document.getElementById('fCufe').value.trim())
        .then(function (r) {
          cerrarModal();
          toast(r.sinCambio ? 'Ya estaba facturada con ese número' : 'Remisión facturada', 'ok');
          return cargar();
        })
        .catch(manejarError);
    };
  }

  // ── Carga ────────────────────────────────────────────────────────────────
  function cargar() {
    return apiFacturaTablero(token).then(function (r) {
      _datos = r;
      pintarCortes(r.totales || {}, (r.sinFacturar || []).length);
      pintarSinFacturar(r.sinFacturar || []);
      pintarCotizaciones(r.cotizaciones || [], r.totales || {});
      pintarFacturas(r.facturasConSaldo || [], r.facturasTotal || 0);
    }).catch(manejarError);
  }

  // Delegación: las tablas se repintan enteras en cada carga, así que enganchar
  // los botones uno por uno los dejaría muertos tras el primer refresco.
  document.addEventListener('click', function (e) {
    var bA = e.target.closest ? e.target.closest('[data-asignar]') : null;
    if (bA) { abrirAsignar(bA.getAttribute('data-asignar'), bA.getAttribute('data-proy')); return; }
    var bF = e.target.closest ? e.target.closest('[data-facturar]') : null;
    if (bF) { abrirFacturarRemision(bF.getAttribute('data-facturar'), bF.getAttribute('data-rot')); return; }
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
