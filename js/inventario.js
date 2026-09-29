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

    cargarLista();
  }
  init();
})();
