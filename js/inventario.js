// ============================================================
// INVENTARIO — recepciones de proveedor y existencias
// ============================================================
//
// PLAN_INVENTARIO.md §11. Tres pestañas:
//   1. Registrar recepción: lo que llegó de un proveedor. La registra quien la
//      recibe —un operario, desde el celular o un computador—.
//   2. Recepciones: el operario ve las suyas; Dirección las aprueba o las
//      rechaza, y puede corregir el costo al aprobar. Hasta que se aprueba, una
//      recepción NO suma al inventario.
//   3. Existencias (Dirección y administrativo): el último conteo más lo que
//      pasó después, con el semáforo de la hoja de siempre.
//
// EL REINTENTO NO DUPLICA. El formulario lleva un `clientId` que se genera al
// abrirlo y no cambia hasta que la recepción queda registrada: si la señal se
// cae a mitad del envío y se vuelve a tocar "Registrar", el servidor reconoce
// el mismo id y no crea otra.
(function () {
  'use strict';

  var session = getSession();
  if (!session || !session.token) { window.location.replace('index.html'); return; }
  var token = session.token;
  // Registrar y ver las propias: todos. Ver todas y las existencias: Dirección
  // y administrativo. Aprobar: solo Dirección (lo decide el servidor y lo dice
  // `puedeAprobar`; esto solo acomoda la pantalla).
  var opera = puedeOperar(session);

  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  // ════════════════════════════════════════════════════════════════════════
  // Funciones puras — `tests/inventario_pantalla.test.js` las extrae por nombre
  // ════════════════════════════════════════════════════════════════════════

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtNum(n, d) {
    if (n == null || n === '') return '—';
    var v = Number(n);
    if (isNaN(v)) return '—';
    return v.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: d == null ? 2 : d });
  }

  function fechaCorta(iso) {
    if (!iso) return '—';
    var p = String(iso).substring(0, 10).split('-');
    if (p.length < 3) return '—';
    return parseInt(p[2], 10) + ' ' + MESES[parseInt(p[1], 10) - 1] + ' ' + p[0];
  }

  /** Cómo se nombra un producto en el buscador. */
  function etiquetaProducto(p) {
    return p.id + ' · ' + p.desc;
  }

  /**
   * El código que escribió o eligió quien registra: la etiqueta del buscador,
   * el código solo (sin importar mayúsculas), o una descripción exacta. Si no
   * es inequívoco, ''.
   */
  function codigoDeTexto(texto, catalogo) {
    var t = String(texto || '').trim();
    if (!t) return '';
    var lista = catalogo || [];
    var cod = t.split('·')[0].trim().toUpperCase();
    for (var i = 0; i < lista.length; i++) if (String(lista[i].id).toUpperCase() === cod) return lista[i].id;
    var porDesc = lista.filter(function (p) { return String(p.desc).trim().toLowerCase() === t.toLowerCase(); });
    return porDesc.length === 1 ? porDesc[0].id : '';
  }

  /** Un número escrito con coma o punto. NaN si no es número. */
  function numero(v) {
    var s = String(v == null ? '' : v).trim().replace(/\s/g, '').replace(',', '.');
    return (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) ? NaN : parseFloat(s);
  }

  /**
   * Lo mínimo antes de mandar: el servidor valida todo otra vez y es quien
   * decide. Esto solo ahorra el viaje con un celular de mala señal.
   * `r` = { fechaIngreso, proveedor, factura, remisionProveedor, lineas: [{ texto, cantidad, costoUnitario }] }.
   * Devuelve { errores, lineas: [{ idProducto, cantidad, costoUnitario }] }.
   */
  function validarRecepcionLocal(r, catalogo, hoy) {
    var errores = [];
    if (!String(r.proveedor || '').trim()) errores.push('Falta el proveedor.');
    if (!String(r.factura || '').trim() && !String(r.remisionProveedor || '').trim()) {
      errores.push('Escribe el número de la factura o de la remisión del proveedor.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.fechaIngreso || ''))) errores.push('Falta la fecha de ingreso.');
    else if (hoy && r.fechaIngreso > hoy) errores.push('La fecha de ingreso no puede estar en el futuro.');
    var lineas = [];
    var vistos = {};
    (r.lineas || []).forEach(function (l, i) {
      var vacia = !String(l.texto || '').trim() && String(l.cantidad == null ? '' : l.cantidad).trim() === '';
      if (vacia) return;                                  // una fila que no se usó
      var n = 'Línea ' + (i + 1);
      var id = codigoDeTexto(l.texto, catalogo);
      if (!id) { errores.push(n + ': elige el producto de la lista.'); return; }
      if (vistos[id]) { errores.push(n + ': ' + id + ' ya está en otra línea.'); return; }
      vistos[id] = true;
      var c = numero(l.cantidad);
      if (!(c > 0)) { errores.push(n + ' (' + id + '): falta la cantidad.'); return; }
      var costo = String(l.costoUnitario == null ? '' : l.costoUnitario).trim();
      if (costo !== '' && !(numero(costo) >= 0)) { errores.push(n + ' (' + id + '): el costo no es un número.'); return; }
      lineas.push({ idProducto: id, cantidad: String(l.cantidad).trim(), costoUnitario: costo });
    });
    if (!lineas.length && !errores.some(function (e) { return /^Línea/.test(e); })) errores.push('Agrega al menos una línea.');
    return { errores: errores, lineas: lineas };
  }

  var ESTADO_TXT = { PENDIENTE: 'Pendiente', APROBADA: 'Aprobada', RECHAZADA: 'Rechazada' };

  /** Una recepción. Con `puedeAprobar` y pendiente: costos editables y los dos botones. */
  function recepcionHtml(rc, puedeAprobar) {
    var editable = puedeAprobar && rc.estado === 'PENDIENTE';
    var docs = [rc.factura ? 'Factura ' + rc.factura : '', rc.remisionProveedor ? 'Remisión ' + rc.remisionProveedor : '',
                rc.ordenCompra ? 'OC ' + rc.ordenCompra : ''].filter(Boolean).join(' · ');
    var h = '<div class="rec-card ' + esc(rc.estado) + '">' +
      '<div class="rec-top"><div><div class="rec-prov">' + esc(rc.proveedor) + '</div>' +
      '<div class="rec-meta">' + esc(docs) + '</div>' +
      '<div class="rec-meta">Ingresó el ' + esc(fechaCorta(rc.fechaIngreso)) + ' · registró ' + esc(rc.creadoNombre || rc.creadoPor) + '</div></div>' +
      '<span class="rec-estado ' + esc(rc.estado) + '">' + esc(ESTADO_TXT[rc.estado] || rc.estado) + '</span></div>';
    h += '<div class="table-wrap"><table class="rec-tabla"><thead><tr><th>Código</th><th>Descripción</th>' +
      '<th class="n">Cantidad</th><th class="n">Costo unitario</th></tr></thead><tbody>' +
      (rc.lineas || []).map(function (l) {
        var costo = editable
          ? '<input type="text" inputmode="decimal" data-costo="' + esc(l.item) + '" value="' + esc(l.costoUnitario == null ? '' : l.costoUnitario) + '">'
          : (l.costoUnitario == null ? '<span class="und">sin costo</span>' : fmtNum(l.costoUnitario));
        return '<tr><td>' + esc(l.idProducto) + '</td><td>' + esc(l.descripcion) + '</td>' +
          '<td class="n"><strong>' + fmtNum(l.cantidad) + '</strong> <span class="und">' + esc(l.unidad) + '</span></td>' +
          '<td class="n">' + costo + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    if (rc.observaciones) h += '<div class="rec-meta" style="margin-top:8px;">' + esc(rc.observaciones) + '</div>';
    if ((rc.avisoConteo || []).length) {
      h += '<div class="rec-aviso">⚠️ Llegó <strong>antes</strong> del último conteo de ' + esc(rc.avisoConteo.join(', ')) +
        ' y se registró <strong>después</strong>. Si ya estaba en planta cuando se contó, aprobarla lo suma dos veces: ' +
        'en ese caso, recházala con ese motivo.</div>';
    }
    if (rc.estado === 'RECHAZADA' && rc.motivoRechazo) h += '<div class="rec-motivo">Motivo: ' + esc(rc.motivoRechazo) + '</div>';
    if (editable) {
      h += '<div class="inv-acciones"><button class="btn btn-ghost btn-sm" data-acc="rechazar" data-id="' + esc(rc.docId) + '">Rechazar</button>' +
        '<button class="btn btn-primary btn-sm" data-acc="aprobar" data-id="' + esc(rc.docId) + '">Aprobar y sumar al inventario</button></div>';
    }
    return h + '</div>';
  }

  /** Cuántos hay de cada cosa, y el valor. */
  function resumenExistencias(items) {
    var r = { total: 0, valor: 0, bajo: 0, sinStock: 0, sinConteo: 0 };
    (items || []).forEach(function (i) {
      r.total++;
      if (i.sinConteo) { r.sinConteo++; return; }
      if (i.estado === 'BAJO') r.bajo++;
      if (i.estado === 'SIN STOCK') r.sinStock++;
      if (i.valor != null) r.valor += i.valor;
    });
    r.valor = Math.round(r.valor);
    return r;
  }

  /** La tabla de existencias, filtrada por código o descripción. Lo que pide atención, primero. */
  function existenciasHtml(res, filtro) {
    var f = String(filtro || '').trim().toLowerCase();
    var items = ((res && res.items) || []).filter(function (i) {
      return !f || String(i.idProducto).toLowerCase().indexOf(f) > -1 || String(i.descripcion).toLowerCase().indexOf(f) > -1;
    });
    var peso = function (i) { return i.sinConteo ? 3 : i.estado === 'SIN STOCK' ? 0 : i.estado === 'BAJO' ? 1 : 2; };
    items.sort(function (a, b) { return (peso(a) - peso(b)) || String(a.descripcion).localeCompare(String(b.descripcion)); });
    var r = resumenExistencias((res && res.items) || []);
    var h = '<div class="ex-resumen">' +
      '<div class="ex-dato"><div class="v">$' + fmtNum(r.valor, 0) + '</div><div class="l">Valor contado</div></div>' +
      '<div class="ex-dato"><div class="v">' + r.sinStock + '</div><div class="l">Sin stock</div></div>' +
      '<div class="ex-dato"><div class="v">' + r.bajo + '</div><div class="l">Bajo el mínimo</div></div>' +
      '<div class="ex-dato"><div class="v">' + r.sinConteo + '</div><div class="l">Sin conteo</div></div></div>';
    h += '<p class="inv-nota">' + (res && res.ultimoCorte
      ? 'Existencia = el último conteo de cada código + lo que entró y salió después. Último conteo: ' + esc(fechaCorta(res.ultimoCorte)) + '.'
      : 'Todavía no hay ningún conteo cargado: sin conteo no hay existencia, solo lo que salió.') + '</p>';
    if (!items.length) return h + '<div class="empty-state"><p>' + (f ? 'Nada coincide con la búsqueda.' : 'No hay códigos contables.') + '</p></div>';
    h += '<div class="table-card"><div class="table-wrap"><table class="ex-tabla"><thead><tr>' +
      '<th>Código</th><th>Descripción</th><th class="n">Existencia</th><th class="n">Mínimo</th><th>Estado</th>' +
      '<th class="n">Valor</th></tr></thead><tbody>' +
      items.map(function (i) {
        var est = i.sinConteo ? 'SIN_CONTEO' : String(i.estado).replace(' ', '_');
        var txt = i.sinConteo ? 'Sin conteo' : i.estado;
        return '<tr><td>' + esc(i.idProducto) + '</td><td>' + esc(i.descripcion) + '</td>' +
          '<td class="n">' + (i.sinConteo ? '<span class="und">—</span>' : '<strong>' + fmtNum(i.stock) + '</strong> <span class="und">' + esc(i.unidad) + '</span>') + '</td>' +
          '<td class="n">' + (i.stockMinimo == null ? '—' : fmtNum(i.stockMinimo)) + '</td>' +
          '<td><span class="ex-estado ' + esc(est) + '">' + esc(txt) + '</span></td>' +
          '<td class="n">' + (i.valor == null ? '—' : '$' + fmtNum(i.valor, 0)) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    return h;
  }

  function nuevoClientId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function hoyBogota() {
    return new Date(Date.now() - 5 * 3600e3).toISOString().substring(0, 10);
  }

  // ── Cargar inventario del mes (InventarioExcel.gs) ──────────────────────
  var EST_MES = { OK: 'OK', VIEJO: 'Código viejo', PROPUESTO: 'Por confirmar', NUEVO: 'Nuevo' };
  var SECCIONES_MES = ['ACCESORIOS', 'DESPACHO', 'MEMBRANAS', 'REPUESTOS'];

  /** El control de una fila por confirmar o nueva: a qué código va, o crearla. */
  function decisionHtml(g) {
    var opciones = (g.candidatos || []).map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === g.sugerido && g.estado === 'PROPUESTO' ? ' selected' : '') + '>' +
        esc(c.id + ' · ' + c.desc) + '</option>';
    }).join('');
    var crear = g.estado === 'NUEVO';
    return '<select data-modo="' + esc(g.clave) + '">' + opciones +
      '<option value="__nuevo"' + (crear ? ' selected' : '') + '>Crear nuevo…</option>' +
      '<option value="__otro">Otro código del catálogo…</option></select>' +
      '<input type="text" data-codigo="' + esc(g.clave) + '" list="dlProductosMes" autocomplete="off" style="margin-top:4px;"' +
      (crear ? ' value="' + esc(g.sugerido) + '"' : ' class="hidden"') + ' placeholder="Código">';
  }

  /** La vista previa del Excel de accesorios. */
  function revisionHtml(res) {
    var grupos = (res && res.grupos) || [];
    var cuenta = { OK: 0, VIEJO: 0, PROPUESTO: 0, NUEVO: 0 };
    grupos.forEach(function (g) { cuenta[g.estado] = (cuenta[g.estado] || 0) + 1; });
    var h = '<div class="mes-cuentas">' + ['OK', 'VIEJO', 'PROPUESTO', 'NUEVO'].map(function (e) {
      return '<span class="mes-est ' + e + '">' + cuenta[e] + ' · ' + EST_MES[e] + '</span>';
    }).join('') + '</div>';
    h += ((res && res.alertas) || []).map(function (a) {
      return '<div class="mes-alerta ' + esc(a.tipo) + '">' + esc(a.texto) + '</div>';
    }).join('');
    h += '<div class="table-wrap" style="margin-top:10px;"><table class="mes-tabla"><thead><tr><th>Sección</th>' +
      '<th class="n">Total del Excel</th><th class="n">Suma de sus filas</th></tr></thead><tbody>' +
      ((res && res.totales) || []).map(function (t) {
        var dif = t.excel != null && Math.abs(t.excel - t.filas) > 1;
        return '<tr><td>' + esc(t.seccion) + '</td><td class="n">' + (t.excel == null ? '—' : '$' + fmtNum(t.excel, 0)) + '</td>' +
          '<td class="n">' + (dif ? '<strong>$' + fmtNum(t.filas, 0) + '</strong>' : '$' + fmtNum(t.filas, 0)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    h += '<div class="table-wrap" style="margin-top:10px;"><table class="mes-tabla"><thead><tr><th>En tu Excel</th>' +
      '<th class="n">Cantidad</th><th>En el sistema</th><th>Estado</th></tr></thead><tbody>';
    SECCIONES_MES.forEach(function (s) {
      var suyos = grupos.filter(function (g) { return g.seccion === s; });
      if (!suyos.length) return;
      h += '<tr class="mes-sec"><td colspan="4">' + esc(s) + '</td></tr>';
      suyos.forEach(function (g) {
        var sistema = (g.estado === 'OK' || g.estado === 'VIEJO')
          ? '<strong>' + esc(g.idProducto) + '</strong> <span class="und">' + esc(g.descSistema) + '</span>'
          : decisionHtml(g);
        var est = g.estado === 'VIEJO' ? 'Código viejo: ' + (g.idExcel || 'sin código') : EST_MES[g.estado];
        h += '<tr><td><span class="und">' + esc(g.idExcel || '—') + '</span> ' + esc(g.desc) + '</td>' +
          '<td class="n">' + (g.cantidad == null ? '<span class="und">sin contar</span>' : fmtNum(g.cantidad)) +
          ' <span class="und">' + esc(g.unidad) + '</span></td><td>' + sistema + '</td>' +
          '<td><span class="mes-est ' + esc(g.estado) + '">' + esc(est) + '</span></td></tr>';
      });
    });
    h += '</tbody></table></div>';
    h += '<label class="inv-nota" style="display:flex;gap:6px;align-items:center;margin-top:10px;">' +
      '<input type="checkbox" id="mesFaltanCero" checked> Lo que no está en mi Excel cuenta como 0 (si no, queda sin contar)</label>';
    h += '<div id="mesAccError" class="inv-error hidden"></div>' +
      '<div class="inv-acciones"><button id="btnCargarAcc" class="btn btn-primary">Cargar conteo</button></div>';
    return h;
  }

  /**
   * Lo que el usuario decidió en las filas por confirmar o nuevas → las
   * decisiones para el servidor. `valores` = { clave: { modo, codigo } }.
   * Devuelve { errores, decisiones: { clave: { idProducto, crear } } }.
   */
  function decisionesDe(grupos, valores, catalogo) {
    var errores = [], decisiones = {}, usados = {};
    (grupos || []).forEach(function (g) {
      if (g.estado === 'OK' || g.estado === 'VIEJO') return;
      var v = (valores || {})[g.clave] || {};
      var modo = v.modo || '';
      if (modo === '__nuevo') {
        var cod = String(v.codigo || '').trim().toUpperCase();
        if (!/^(IN|VA|RP)-[A-Z0-9.\-]+$/.test(cod)) { errores.push('"' + g.desc + '": escribe el código nuevo (IN-…, VA-… o RP-…).'); return; }
        if (codigoDeTexto(cod, catalogo)) { errores.push('"' + g.desc + '": ' + cod + ' ya existe. Elige "Otro código del catálogo".'); return; }
        if (usados[cod]) { errores.push('"' + g.desc + '": el código nuevo ' + cod + ' ya lo usa otra fila.'); return; }
        usados[cod] = true;
        decisiones[g.clave] = { idProducto: cod, crear: true };
        return;
      }
      var id = modo === '__otro' ? codigoDeTexto(v.codigo, catalogo) : modo;
      if (!id) { errores.push('"' + g.desc + '": elige a qué código va.'); return; }
      decisiones[g.clave] = { idProducto: id };
    });
    return { errores: errores, decisiones: decisiones };
  }

  /** La vista previa del registro de acero. */
  function aceroHtml(res) {
    var h = '<div class="ex-resumen" style="margin-top:10px;">' +
      '<div class="ex-dato"><div class="v">' + fmtNum(res.filas) + '</div><div class="l">Filas en el Excel</div></div>' +
      '<div class="ex-dato"><div class="v">' + fmtNum(res.nuevas) + '</div><div class="l">Que el sistema no tenía</div></div>' +
      '<div class="ex-dato"><div class="v">' + fmtNum(res.enStock) + '</div><div class="l">En stock (' + fmtNum(res.kgStock, 0) + ' kg)</div></div>' +
      '<div class="ex-dato"><div class="v">' + fmtNum(res.revisadas) + '</div><div class="l">Verificadas (' + fmtNum(res.kgRevisadas, 0) + ' kg)</div></div>' +
      '<div class="ex-dato"><div class="v">$' + fmtNum(res.valorRevisadas, 0) + '</div><div class="l">Valor verificado</div></div></div>';
    h += '<div class="form-group" style="max-width:320px;"><label for="mesRevDesde">Verificadas: Rev. Física desde</label>' +
      '<select id="mesRevDesde">' + (res.fechas || []).map(function (f) {
        return '<option value="' + esc(f.fecha) + '"' + (f.fecha === res.revDesde ? ' selected' : '') + '>' +
          esc(fechaCorta(f.fecha)) + ' (' + f.bobinas + ' bobinas)</option>';
      }).join('') + '</select></div>';
    if (res.valoracion && res.valoracion.kg != null) {
      h += '<p class="inv-nota">La Valoración del Excel dice ' + fmtNum(res.valoracion.kg, 0) + ' kg y $' + fmtNum(res.valoracion.valor, 0) + '.</p>';
    }
    h += (res.alertas || []).map(function (a) { return '<div class="mes-alerta ' + esc(a.tipo) + '">' + esc(a.texto) + '</div>'; }).join('');
    h += '<div id="mesAceroError" class="inv-error hidden"></div>' +
      '<div class="inv-acciones"><button id="btnCargarAcero" class="btn btn-primary">Reemplazar el registro y cargar la verificación</button></div>';
    return h;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Pantalla
  // ════════════════════════════════════════════════════════════════════════

  function $(id) { return document.getElementById(id); }

  function toast(msg, tipo) {
    var cont = $('toastContainer');
    if (!cont) return;
    var bg = { success: '#065F46', error: '#B91C1C', warning: '#92400E' }[tipo] || '#1E40AF';
    var el = document.createElement('div');
    el.style.cssText = 'background:' + bg + ';color:#fff;padding:12px 16px;border-radius:10px;font-size:0.85rem;' +
      'font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.22);pointer-events:auto;max-width:320px;white-space:pre-line;';
    el.textContent = msg;
    cont.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  function fallo(e, donde) {
    if (e && e.tipo === 'auth') {
      toast('Tu sesión venció. Vuelve a entrar.', 'error');
      setTimeout(function () { clearSession(); window.location.replace('index.html'); }, 1500);
      return;
    }
    if (donde) donde.innerHTML = '<div class="inv-error">' + esc((e && e.message) || 'No se pudo cargar.') + '</div>';
    else toast((e && e.message) || 'Algo falló.', 'error');
  }

  var _catalogo = [];
  var _lista = null;
  var _stock = null;
  var _clientId = nuevoClientId();

  // ── Registrar ──────────────────────────────────────────────────────────
  function filaLineaHtml() {
    return '<div class="rec-linea">' +
      '<div class="rec-cod"><label>Producto</label><input type="text" list="dlProductos" data-campo="texto" autocomplete="off" placeholder="Código o descripción">' +
      '<div class="rec-und" data-und></div></div>' +
      '<div><label>Cantidad</label><input type="text" inputmode="decimal" data-campo="cantidad"></div>' +
      '<div><label>Costo unitario</label><input type="text" inputmode="decimal" data-campo="costoUnitario" placeholder="opcional"></div>' +
      '<button type="button" class="rec-quitar" data-quitar title="Quitar la línea" aria-label="Quitar la línea">✕</button></div>';
  }
  function agregarLinea() {
    $('recLineas').insertAdjacentHTML('beforeend', filaLineaHtml());
  }
  function leerFormulario() {
    return {
      clientId: _clientId,
      fechaIngreso: $('recFecha').value, proveedor: $('recProveedor').value.trim(),
      factura: $('recFactura').value.trim(), remisionProveedor: $('recRemision').value.trim(),
      ordenCompra: $('recOC').value.trim(), observaciones: $('recObs').value.trim(),
      lineas: Array.prototype.map.call(document.querySelectorAll('#recLineas .rec-linea'), function (f) {
        var v = function (k) { return f.querySelector('[data-campo="' + k + '"]').value; };
        return { texto: v('texto'), cantidad: v('cantidad'), costoUnitario: v('costoUnitario') };
      }),
    };
  }
  function limpiarFormulario() {
    ['recProveedor', 'recFactura', 'recRemision', 'recOC', 'recObs'].forEach(function (id) { $(id).value = ''; });
    $('recFecha').value = hoyBogota();
    $('recLineas').innerHTML = '';
    agregarLinea(); agregarLinea(); agregarLinea();
    $('recError').classList.add('hidden');
    _clientId = nuevoClientId();
  }
  function registrar() {
    var f = leerFormulario();
    var v = validarRecepcionLocal(f, _catalogo, hoyBogota());
    var caja = $('recError');
    if (v.errores.length) { caja.textContent = v.errores.join('\n'); caja.classList.remove('hidden'); return; }
    caja.classList.add('hidden');
    var envio = { clientId: f.clientId, fechaIngreso: f.fechaIngreso, proveedor: f.proveedor, factura: f.factura,
                  remisionProveedor: f.remisionProveedor, ordenCompra: f.ordenCompra, observaciones: f.observaciones,
                  lineas: v.lineas };
    var btn = $('btnRegistrar');
    btn.disabled = true;
    apiInvRecepcionCrear(token, envio)
      .then(function () {
        toast('Recepción registrada. Queda pendiente de aprobación.', 'success');
        limpiarFormulario();
        cargarLista();
      })
      .catch(function (e) {
        if (e && e.tipo === 'auth') { fallo(e); return; }
        // El clientId NO cambia: reintentar no duplica.
        caja.textContent = (e && e.message) || 'No se pudo registrar. Revisa la señal y vuelve a tocar Registrar.';
        caja.classList.remove('hidden');
      })
      .finally(function () { btn.disabled = false; });
  }
  function mostrarUnidad(input) {
    var fila = input.closest('.rec-linea');
    var id = codigoDeTexto(input.value, _catalogo);
    var p = _catalogo.filter(function (x) { return x.id === id; })[0];
    fila.querySelector('[data-und]').textContent = p ? p.desc + ' · en ' + (p.und || 'unidades') : '';
    var costo = fila.querySelector('[data-campo="costoUnitario"]');
    if (p && p.costo != null && !costo.value) costo.placeholder = 'último: ' + fmtNum(p.costo);
  }

  // ── Recepciones ────────────────────────────────────────────────────────
  function pintarLista() {
    var cuerpo = $('recLista');
    var res = _lista;
    if (!res) return;
    var pend = (res.recepciones || []).filter(function (r) { return r.estado === 'PENDIENTE'; }).length;
    var cuenta = $('cuentaPendientes');
    cuenta.textContent = pend;
    cuenta.classList.toggle('hidden', !pend);
    $('recListaNota').textContent = res.puedeAprobar
      ? (pend ? pend + ' pendiente(s) de aprobar.' : 'Nada pendiente de aprobar.')
      : (opera ? 'Las recepciones registradas. Las aprueba Dirección.' : 'Las recepciones que registraste. Las aprueba Dirección.');
    cuerpo.innerHTML = (res.recepciones || []).length
      ? res.recepciones.map(function (r) { return recepcionHtml(r, res.puedeAprobar); }).join('')
      : '<div class="empty-state"><p>No hay recepciones registradas.</p></div>';
  }
  function cargarLista() {
    return apiInvRecepcionLista(token).then(function (r) {
      _lista = r;
      _catalogo = r.catalogo || [];
      $('dlProductos').innerHTML = _catalogo.map(function (p) { return '<option value="' + esc(etiquetaProducto(p)) + '"></option>'; }).join('');
      $('dlProveedores').innerHTML = (r.proveedores || []).map(function (p) { return '<option value="' + esc(p) + '"></option>'; }).join('');
      pintarLista();
    }).catch(function (e) { fallo(e, $('recLista')); });
  }
  function aprobar(docId, tarjeta) {
    var costos = {};
    Array.prototype.forEach.call(tarjeta.querySelectorAll('[data-costo]'), function (inp) { costos[inp.getAttribute('data-costo')] = inp.value.trim(); });
    if (!window.confirm('¿Aprobar esta recepción? Suma al inventario y no se puede deshacer desde aquí.')) return;
    apiInvRecepcionAprobar(token, docId, costos)
      .then(function () { toast('Aprobada: ya suma al inventario.', 'success'); return Promise.all([cargarLista(), _stock ? cargarStock() : null]); })
      .catch(function (e) { fallo(e); });
  }
  function rechazar(docId) {
    var motivo = window.prompt('¿Por qué se rechaza? Quien la registró lo va a ver.');
    if (motivo == null) return;
    if (!motivo.trim()) { toast('Escribe el motivo.', 'warning'); return; }
    apiInvRecepcionRechazar(token, docId, motivo.trim())
      .then(function () { toast('Rechazada.', 'success'); return cargarLista(); })
      .catch(function (e) { fallo(e); });
  }

  // ── Existencias ────────────────────────────────────────────────────────
  function pintarStock() {
    if (_stock) $('exCuerpo').innerHTML = existenciasHtml(_stock, $('exFiltro').value);
  }
  function cargarStock() {
    return apiInvStock(token).then(function (r) { _stock = r; pintarStock(); })
      .catch(function (e) { fallo(e, $('exCuerpo')); });
  }

  // ── Cargar inventario del mes ──────────────────────────────────────────
  var _revAcc = null;     // la última revisión del Excel de accesorios
  var _archAcero = null;  // { nombre, base64 } del último Excel de acero revisado

  function leerArchivo(input) {
    return new Promise(function (resolve, reject) {
      var f = input.files && input.files[0];
      if (!f) { reject(new Error('Elige el archivo .xlsx.')); return; }
      if (!/\.xlsx$/i.test(f.name)) { reject(new Error('Tiene que ser un .xlsx (el Excel de siempre).')); return; }
      var r = new FileReader();
      r.onload = function () { resolve({ nombre: f.name, base64: String(r.result).replace(/^data:[^,]*,/, '') }); };
      r.onerror = function () { reject(new Error('No pude leer el archivo.')); };
      r.readAsDataURL(f);
    });
  }

  function datosCorte() {
    return { corte: $('mesCorte').value, quien: $('mesQuien').value.trim(), atrasado: $('mesAtrasado').checked };
  }

  /** Un rechazo del servidor por un corte de hace más de una semana: ofrece la casilla. */
  function errorDeCarga(e, caja) {
    if (e && e.tipo === 'auth') { fallo(e); return; }
    if (e && e.datos && e.datos.atrasado) $('mesAtrasadoCaja').classList.remove('hidden');
    caja.textContent = (e && e.message) || 'No se pudo cargar.';
    caja.classList.remove('hidden');
  }

  function revisarAcc() {
    var cuerpo = $('mesAcc'), btn = $('btnRevisarAcc');
    btn.disabled = true;
    cuerpo.innerHTML = '<p class="inv-nota">Leyendo el Excel…</p>';
    leerArchivo($('mesArchAcc'))
      .then(function (a) {
        return apiInvExcelRevisar(token, { tipo: 'accesorios', archivo: a.base64, nombre: a.nombre })
          .then(function (r) { r.archivo = a; return r; });
      })
      .then(function (r) {
        _revAcc = r;
        $('dlProductosMes').innerHTML = (r.catalogo || []).map(function (p) {
          return '<option value="' + esc(etiquetaProducto(p)) + '"></option>';
        }).join('');
        cuerpo.innerHTML = revisionHtml(r);
      })
      .catch(function (e) { fallo(e, cuerpo); })
      .finally(function () { btn.disabled = false; });
  }

  function cargarAcc() {
    if (!_revAcc) return;
    var caja = $('mesAccError');
    caja.classList.add('hidden');
    var valores = {};
    Array.prototype.forEach.call(document.querySelectorAll('#mesAcc [data-modo]'), function (s) {
      var clave = s.getAttribute('data-modo');
      var inp = document.querySelector('#mesAcc [data-codigo="' + CSS.escape(clave) + '"]');
      valores[clave] = { modo: s.value, codigo: inp ? inp.value : '' };
    });
    var d = decisionesDe(_revAcc.grupos, valores, _revAcc.catalogo || []);
    var c = datosCorte();
    if (!c.corte) d.errores.unshift('Falta la fecha y hora del corte del conteo (arriba).');
    if (d.errores.length) { caja.textContent = d.errores.join('\n'); caja.classList.remove('hidden'); return; }
    var nuevos = Object.keys(d.decisiones).filter(function (k) { return d.decisiones[k].crear; }).length;
    if (!window.confirm('¿Cargar el conteo con corte ' + c.corte.replace('T', ' ') + '?' +
        (nuevos ? '\nSe crean ' + nuevos + ' producto(s) nuevo(s) en el catálogo.' : '') +
        '\nQueda el cierre del mes y no se deshace desde aquí.')) return;
    var btn = $('btnCargarAcc');
    btn.disabled = true;
    apiInvExcelCargar(token, { tipo: 'accesorios', archivo: _revAcc.archivo.base64, nombre: _revAcc.archivo.nombre,
                               corte: c.corte, quien: c.quien, atrasado: c.atrasado, decisiones: d.decisiones,
                               faltanEnCero: $('mesFaltanCero').checked })
      .then(function (r) {
        $('mesAcc').innerHTML = '<div class="mes-ok">✅ Conteo cargado: ' + r.lineas + ' códigos.' +
          (r.creados && r.creados.length ? '\nProductos nuevos: ' + r.creados.join(' · ') : '') +
          (r.equivalencias ? '\nEquivalencias guardadas para el próximo mes: ' + r.equivalencias + '.' : '') +
          '\n' + r.mensaje + '</div>';
        _revAcc = null;
        _stock = null;
        toast('Conteo cargado.', 'success');
      })
      .catch(function (e) { errorDeCarga(e, caja); })
      .finally(function () { btn.disabled = false; });
  }

  function revisarAcero(revDesde) {
    var cuerpo = $('mesAcero'), btn = $('btnRevisarAcero');
    btn.disabled = true;
    cuerpo.innerHTML = '<p class="inv-nota">Leyendo el Excel…</p>';
    var archivo = revDesde && _archAcero ? Promise.resolve(_archAcero) : leerArchivo($('mesArchAcero'));
    archivo
      .then(function (a) {
        _archAcero = a;
        return apiInvExcelRevisar(token, { tipo: 'acero', archivo: a.base64, nombre: a.nombre, revDesde: revDesde || '' });
      })
      .then(function (r) { cuerpo.innerHTML = aceroHtml(r); })
      .catch(function (e) { fallo(e, cuerpo); })
      .finally(function () { btn.disabled = false; });
  }

  function cargarAcero() {
    if (!_archAcero) return;
    var caja = $('mesAceroError');
    caja.classList.add('hidden');
    var c = datosCorte();
    if (!c.corte) { caja.textContent = 'Falta la fecha y hora del corte del conteo (arriba).'; caja.classList.remove('hidden'); return; }
    var desde = $('mesRevDesde') ? $('mesRevDesde').value : '';
    if (!window.confirm('¿Reemplazar el registro de bobinas del sistema con este Excel y cargar la verificación ' +
        '(Rev. Física desde ' + desde + ', corte ' + c.corte.replace('T', ' ') + ')?')) return;
    var btn = $('btnCargarAcero');
    btn.disabled = true;
    apiInvExcelCargar(token, { tipo: 'acero', archivo: _archAcero.base64, nombre: _archAcero.nombre,
                               corte: c.corte, quien: c.quien, atrasado: c.atrasado, revDesde: desde })
      .then(function (r) {
        $('mesAcero').innerHTML = '<div class="mes-ok">' + esc(r.mensaje) + '</div>';
        _archAcero = null;
        toast('Acero cargado.', 'success');
      })
      .catch(function (e) { errorDeCarga(e, caja); })
      .finally(function () { btn.disabled = false; });
  }

  // ── Arranque ───────────────────────────────────────────────────────────
  function mostrarTab(nombre) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === nombre);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab-panel'), function (p) {
      p.classList.toggle('active', p.id === 'panel-' + nombre);
    });
    if (nombre === 'existencias' && !_stock) cargarStock();
  }

  function init() {
    $('userName').textContent = session.nombre || '';
    if (opera) {
      $('modNav').classList.remove('hidden');
      $('tabExistencias').classList.remove('hidden');
      // Cargar el mes es el cierre contable: solo Dirección (lo valida el servidor).
      if (esDireccion(session)) $('tabMes').classList.remove('hidden');
    } else {
      $('lnkInicio').classList.remove('hidden');
    }
    $('logoutBtn').addEventListener('click', function () {
      if (!window.confirm('¿Cerrar sesión?')) return;
      clearSession(); window.location.replace('index.html');
    });
    document.querySelector('.tabs').addEventListener('click', function (e) {
      var b = e.target.closest('.tab-btn');
      if (b) mostrarTab(b.getAttribute('data-tab'));
    });

    limpiarFormulario();
    $('btnAgregarLinea').addEventListener('click', agregarLinea);
    $('btnLimpiar').addEventListener('click', function () { if (window.confirm('¿Borrar lo escrito?')) limpiarFormulario(); });
    $('btnRegistrar').addEventListener('click', registrar);
    $('recLineas').addEventListener('click', function (e) {
      var q = e.target.closest('[data-quitar]');
      if (!q) return;
      q.closest('.rec-linea').remove();
      if (!document.querySelector('#recLineas .rec-linea')) agregarLinea();
    });
    $('recLineas').addEventListener('change', function (e) {
      if (e.target.getAttribute('data-campo') === 'texto') mostrarUnidad(e.target);
    });

    $('btnRefrescarLista').addEventListener('click', cargarLista);
    $('recLista').addEventListener('click', function (e) {
      var b = e.target.closest('[data-acc]');
      if (!b) return;
      var id = b.getAttribute('data-id');
      if (b.getAttribute('data-acc') === 'aprobar') aprobar(id, b.closest('.rec-card'));
      else rechazar(id);
    });

    $('btnRefrescarEx').addEventListener('click', cargarStock);
    $('exFiltro').addEventListener('input', pintarStock);

    $('btnRevisarAcc').addEventListener('click', revisarAcc);
    $('btnRevisarAcero').addEventListener('click', function () { revisarAcero(''); });
    $('mesAcc').addEventListener('change', function (e) {
      var clave = e.target.getAttribute('data-modo');
      if (clave == null) return;
      var inp = document.querySelector('#mesAcc [data-codigo="' + CSS.escape(clave) + '"]');
      var g = (_revAcc && _revAcc.grupos || []).filter(function (x) { return x.clave === clave; })[0];
      var conCodigo = e.target.value === '__nuevo' || e.target.value === '__otro';
      inp.classList.toggle('hidden', !conCodigo);
      inp.value = e.target.value === '__nuevo' && g ? (g.sugerido || '') : '';
      if (conCodigo) inp.focus();
    });
    $('mesAcc').addEventListener('click', function (e) { if (e.target.id === 'btnCargarAcc') cargarAcc(); });
    $('mesAcero').addEventListener('click', function (e) { if (e.target.id === 'btnCargarAcero') cargarAcero(); });
    $('mesAcero').addEventListener('change', function (e) { if (e.target.id === 'mesRevDesde') revisarAcero(e.target.value); });

    cargarLista();
  }
  init();
})();
