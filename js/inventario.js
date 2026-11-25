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
  // La bobina del QR del sticker (25-nov): `?bobina=CODIGO` abre la pestaña
  // Acero con esa bobina. Sin sesión, el login vuelve aquí (destinoTrasLogin).
  var bobinaQR = '';
  try { bobinaQR = String(new URLSearchParams(location.search).get('bobina') || '').trim().toUpperCase(); } catch (e) { bobinaQR = ''; }
  if (!session || !session.token) {
    if (bobinaQR) { try { sessionStorage.setItem('cf_volver', 'inventario.html?bobina=' + encodeURIComponent(bobinaQR)); } catch (e) { /* nada */ } }
    window.location.replace('index.html'); return;
  }
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

  // ── Acero (25-nov) ─────────────────────────────────────────────────────
  /**
   * El código que sigue: "1560-05" → "1560-06", "31324-9" → "31324-10". Sin un
   * número al final, vacío (el operario lo escribe). Respeta los ceros.
   */
  /** "COLFRAME BARRIO COLOMBIA" → "Barrio Colombia": para mostrar (26-nov). */
  function sedeCorta(s) {
    var t = String(s || '').trim().replace(/^COLFRAME\s+/i, '').toLowerCase();
    return t.replace(/(^|\s)([a-záéíóúñ])/g, function (m, a, b) { return a + b.toUpperCase(); });
  }

  function siguienteCodigo(cod) {
    var m = String(cod || '').trim().match(/^(.*?)(\d+)$/);
    if (!m) return '';
    var n = String(parseInt(m[2], 10) + 1);
    while (n.length < m[2].length) n = '0' + n;
    return m[1] + n;
  }

  /**
   * Lo mínimo de una recepción de acero antes de mandarla; el servidor valida
   * todo otra vez (rangos de peso y precio, valores conocidos, códigos usados).
   * `r.lineas` = [{ codigo, calibre, grado, galvanizado, pesoKg, precioKg }].
   */
  function validarAceroLocal(r, hoy, desde) {
    var errores = [];
    if (!String(r.proveedor || '').trim()) errores.push('Falta el proveedor.');
    if (!String(r.factura || '').trim() && !String(r.remisionProveedor || '').trim()) {
      errores.push('Escribe el número de la factura o de la remisión del proveedor.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.fechaIngreso || ''))) errores.push('Falta la fecha de ingreso.');
    else if (hoy && r.fechaIngreso > hoy) errores.push('La fecha de ingreso no puede estar en el futuro.');
    else if (desde && r.fechaIngreso < desde) errores.push('El acero que entró antes del ' + desde + ' va en el Excel CF-RG-ALM-001, no aquí.');
    var lineas = [], vistos = {};
    (r.lineas || []).forEach(function (l, i) {
      var vacia = ['codigo', 'pesoKg'].every(function (k) { return !String(l[k] == null ? '' : l[k]).trim(); });
      if (vacia) return;
      var n = 'Bobina ' + (i + 1);
      var cod = String(l.codigo || '').trim().toUpperCase();
      if (!cod) { errores.push(n + ': falta el código.'); return; }
      if (vistos[cod]) { errores.push(n + ': el código ' + cod + ' está dos veces.'); return; }
      vistos[cod] = true;
      if (!String(l.calibre || '') || !String(l.grado || '') || !String(l.galvanizado || '')) { errores.push(n + ' (' + cod + '): elige calibre, grado y galvanizado.'); return; }
      if (!(numero(l.pesoKg) > 0)) { errores.push(n + ' (' + cod + '): falta el peso neto.'); return; }
      if (!(numero(l.precioKg) > 0)) { errores.push(n + ' (' + cod + '): falta el precio por kg.'); return; }
      lineas.push({ codigo: cod, calibre: l.calibre, grado: l.grado, galvanizado: l.galvanizado,
                    pesoKg: String(l.pesoKg).trim(), precioKg: String(l.precioKg).trim() });
    });
    if (!lineas.length && !errores.some(function (e) { return /^Bobina/.test(e); })) errores.push('Agrega al menos una bobina.');
    return { errores: errores, lineas: lineas };
  }

  /** La tabla de bobinas de una recepción de acero, para su tarjeta. */
  function bobinasRecepcionHtml(rc) {
    var bs = rc.bobinas || [];
    var kg = bs.reduce(function (t, b) { return t + (+b.pesoKg || 0); }, 0);
    return '<div class="table-wrap"><table class="rec-tabla"><thead><tr><th>Código</th><th>Calibre</th><th>Grado</th>' +
      '<th>Galvanizado</th><th class="n">Peso neto</th><th class="n">$ / kg</th></tr></thead><tbody>' +
      bs.map(function (b) {
        return '<tr><td>' + esc(b.codigo) + '</td><td>' + esc(b.calibre) + '</td><td>' + esc(b.grado) + '</td><td>' + esc(b.galvanizado) +
          '</td><td class="n"><strong>' + fmtNum(b.pesoKg, 0) + '</strong> <span class="und">kg</span></td><td class="n">' +
          (b.precioKg == null ? '—' : fmtNum(b.precioKg, 0)) + '</td></tr>';
      }).join('') +
      '<tr><td colspan="4"><strong>' + bs.length + ' bobina' + (bs.length === 1 ? '' : 's') + '</strong></td><td class="n"><strong>' +
      fmtNum(kg, 0) + '</strong> <span class="und">kg</span></td><td></td></tr></tbody></table></div>';
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
      '<div class="rec-meta">Ingresó el ' + esc(fechaCorta(rc.fechaIngreso)) + (rc.sede ? ' a ' + esc(sedeCorta(rc.sede)) : '') +
        ' · registró ' + esc(rc.creadoNombre || rc.creadoPor) + '</div></div>' +
      '<span class="rec-estado ' + esc(rc.estado) + '">' + (rc.tipo === 'ACERO' ? 'Acero · ' : '') + esc(ESTADO_TXT[rc.estado] || rc.estado) + '</span></div>';
    if (rc.tipo === 'ACERO') {
      h += bobinasRecepcionHtml(rc);
      if (rc.observaciones) h += '<div class="rec-meta" style="margin-top:8px;">' + esc(rc.observaciones) + '</div>';
      if (rc.estado === 'RECHAZADA' && rc.motivoRechazo) h += '<div class="rec-motivo">Motivo: ' + esc(rc.motivoRechazo) + '</div>';
      if (editable) {
        h += '<div class="inv-acciones"><button class="btn btn-ghost btn-sm" data-acc="rechazar" data-id="' + esc(rc.docId) + '">Rechazar</button>' +
          '<button class="btn btn-primary btn-sm" data-acc="aprobar" data-id="' + esc(rc.docId) + '">Aprobar: entran al acero en planta</button></div>';
      }
      return h + '</div>';
    }
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

  // Las categorías de Existencias (5-nov). Agrupan las secciones del conteo
  // —las pestañas del Excel, que no cambian—: las membranas van con los
  // accesorios, y "insumos de fabricación" es lo de despacho.
  var CATEGORIAS_EX = [['', 'Todas'], ['ACCESORIOS', 'Accesorios'], ['REPUESTOS', 'Repuestos'],
                       ['INSUMOS', 'Insumos de fabricación'], ['OTROS', 'Otros']];

  /** La categoría de un producto por su sección del conteo. */
  function categoriaDe(seccion) {
    var s = String(seccion || '').trim().toUpperCase();
    if (s === 'ACCESORIOS' || s === 'MEMBRANAS') return 'ACCESORIOS';
    if (s === 'REPUESTOS') return 'REPUESTOS';
    if (s === 'DESPACHO') return 'INSUMOS';
    return 'OTROS';
  }

  /**
   * La tabla de existencias, filtrada por categoría (botones) y por código o
   * descripción. El resumen —valor, sin stock, bajo el mínimo— es el de la
   * categoría elegida. Lo que pide atención, primero.
   */
  function existenciasHtml(res, filtro, categoria) {
    var f = String(filtro || '').trim().toLowerCase();
    var cat = categoria || '';
    var todos = (res && res.items) || [];
    var deCat = todos.filter(function (i) { return !cat || categoriaDe(i.seccion) === cat; });
    var items = deCat.filter(function (i) {
      return !f || String(i.idProducto).toLowerCase().indexOf(f) > -1 || String(i.descripcion).toLowerCase().indexOf(f) > -1;
    });
    var peso = function (i) { return i.sinConteo ? 3 : i.estado === 'SIN STOCK' ? 0 : i.estado === 'BAJO' ? 1 : 2; };
    items.sort(function (a, b) { return (peso(a) - peso(b)) || String(a.descripcion).localeCompare(String(b.descripcion)); });
    var cuenta = {};
    todos.forEach(function (i) { var c = categoriaDe(i.seccion); cuenta[c] = (cuenta[c] || 0) + 1; });
    var h = '<div class="ex-cats">' + CATEGORIAS_EX.filter(function (c) { return !c[0] || cuenta[c[0]]; }).map(function (c) {
      return '<button type="button" class="ex-cat' + (c[0] === cat ? ' on' : '') + '" data-cat="' + c[0] + '">' +
        esc(c[1]) + ' <span class="und">' + (c[0] ? cuenta[c[0]] : todos.length) + '</span></button>';
    }).join('') + '</div>';
    var r = resumenExistencias(deCat);
    h += '<div class="ex-resumen">' +
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

  /**
   * La pestaña Acero (25-nov): el acero que hay HOY —lo verificado en el último
   * corte, más lo que entró, menos lo que se marcó consumido—, por calibre ×
   * grado × galvanizado y bobina por bobina, con los botones para marcarlas.
   * Los valores ($) solo si el servidor los manda (Dirección y Administrativo).
   * Lo que el registro dice "En stock" sin que el corte lo viera va APARTE.
   * `f` filtra las bobinas por código, calibre, grado, proveedor o factura.
   *
   * Se llama aceroVistaHtml y no aceroHtml: ese nombre ya lo tiene la vista
   * previa del Excel de acero (Cargar inventario del mes), y en un mismo
   * bloque la última declaración gana (lo vigila sin_funciones_repetidas.test).
   */
  function aceroVistaHtml(a, f, sedeFiltro) {
    if (!a) return '<div class="empty-state"><p>Cargando el acero…</p></div>';
    if (a.sinCierre) return '<div class="empty-state"><p>Todavía no hay ninguna verificación de acero cargada.</p></div>';
    var kg = function (n) { return fmtNum(n, 0) + ' <span class="und">kg</span>'; };
    var val = !!a.verValores;
    var h = '<div class="ex-resumen">' +
      '<div class="ex-dato"><div class="v">' + fmtNum(a.enPlanta.kg, 0) + '</div><div class="l">kg en planta</div></div>' +
      '<div class="ex-dato"><div class="v">' + a.enPlanta.bobinas + '</div><div class="l">Bobinas</div></div>' +
      (val ? '<div class="ex-dato"><div class="v">$' + fmtNum(a.enPlanta.valor, 0) + '</div><div class="l">Valor</div></div>' +
             '<div class="ex-dato"><div class="v">' + (a.precioKg == null ? '—' : '$' + fmtNum(a.precioKg, 0)) + '</div><div class="l">Precio ponderado / kg</div></div>' : '') +
      '</div>';
    var d = a.desdeCorte || {};
    var cambios = [d.entraron ? '+' + d.entraron + ' entraron' : '', d.salieron ? '−' + d.salieron + ' consumidas o descartadas' : '',
                   d.parciales ? d.parciales + ' a medio usar' : ''].filter(Boolean).join(' · ');
    h += '<p class="inv-nota">Desde la verificación del <strong>' + esc(fechaCorta(a.corte)) + '</strong>' +
      (cambios ? ': ' + esc(cambios) + '.' : ', sin cambios.') +
      (a.fueraPlanta && a.fueraPlanta.bobinas ? ' Fuera de planta (Bogotá): ' + a.fueraPlanta.bobinas + ' · ' + fmtNum(a.fueraPlanta.kg, 0) + ' kg, aparte.' : '') +
      '</p>';
    h += '<div class="table-card"><div class="table-wrap"><table class="ex-tabla"><thead><tr>' +
      '<th>Calibre</th><th>Grado</th><th>Galvanizado</th><th class="n">Bobinas</th><th class="n">Kg</th>' + (val ? '<th class="n">Valor</th>' : '') +
      '</tr></thead><tbody>' + (a.grupos || []).map(function (g) {
        return '<tr><td><strong>' + esc(g.calibre) + '</strong></td><td>' + esc(g.grado) + '</td><td>' + esc(g.galvanizado) + '</td>' +
          '<td class="n">' + g.bobinas + '</td><td class="n">' + kg(g.kg) + '</td>' + (val ? '<td class="n">$' + fmtNum(g.valor, 0) + '</td>' : '') + '</tr>';
      }).join('') + '</tbody></table></div></div>';
    if (a.sinVerificar && a.sinVerificar.bobinas) {
      h += '<details class="inv-nota"><summary>El registro dice además <strong>' + a.sinVerificar.bobinas + ' bobinas · ' +
        fmtNum(a.sinVerificar.kg, 0) + ' kg</strong> "En stock" que no se verificaron en ese corte' +
        (a.noEstan && a.noEstan.bobinas ? ', y ' + a.noEstan.bobinas + ' que se buscaron y no estaban' : '') +
        '. No cuentan arriba: lo más probable es que ya se consumieron y nadie les cambió el estado.</summary>' +
        '<table class="ex-tabla"><tbody>' + (a.gruposSinVerificar || []).map(function (g) {
          return '<tr><td>' + esc(g.calibre) + ' · ' + esc(g.grado) + ' · ' + esc(g.galvanizado) + '</td><td class="n">' + g.bobinas +
            '</td><td class="n">' + kg(g.kg) + '</td></tr>';
        }).join('') + '</tbody></table></details>';
    }
    // Por sede (26-nov): cuánto hay en cada una, y el filtro.
    var porSede = a.porSede || [];
    var sede = sedeFiltro || '';
    if (porSede.length > 1 || (porSede.length === 1 && (a.sedesActivas || []).length > 1)) {
      h += '<div class="ex-cats" style="margin-top:12px;">' +
        '<button type="button" class="ex-cat' + (!sede ? ' on' : '') + '" data-acsede="">Todas las sedes <span class="und">' + a.enPlanta.bobinas + '</span></button>' +
        porSede.map(function (s) {
          return '<button type="button" class="ex-cat' + (s.sede === sede ? ' on' : '') + '" data-acsede="' + esc(s.sede) + '">' + esc(sedeCorta(s.sede)) +
            ' <span class="und">' + s.bobinas + ' · ' + fmtNum(s.kg, 0) + ' kg</span></button>';
        }).join('') + '</div>';
    }
    var todas = (a.bobinas || []).filter(function (b) { return !sede || b.sede === sede; });
    var bs = todas.filter(function (b) {
      if (!f) return true;
      return [b.codigo, b.calibre, b.grado, b.galvanizado, b.proveedor, b.factura, b.sede].join(' ').toLowerCase().indexOf(f) > -1;
    });
    var otrasSedes = function (b) { return (a.sedesActivas || []).filter(function (s) { return s !== b.sede; }); };
    h += '<div class="inv-sub">Bobinas en planta' + (sede ? ' en ' + esc(sedeCorta(sede)) : '') + (f ? ' (' + bs.length + ' de ' + todas.length + ')' : '') + '</div>' +
      '<p class="inv-nota" style="margin-top:0;">Al desmontar una a medio usar: <strong>Parcial</strong> y los kg que le quedan (sale su sticker nuevo). Al terminarla: <strong>Consumida</strong>.</p>';
    if (!bs.length) return h + '<div class="empty-state"><p>' + (f ? 'Ninguna bobina coincide con la búsqueda.' : 'No hay bobinas en planta.') + '</p></div>';
    // Tarjetas y no tabla: se marca desde el celular junto a la máquina, y en
    // una tabla los botones quedaban fuera de la pantalla (medido: 684 px de
    // tabla en 375 de pantalla).
    return h + '<div class="ac-bobinas">' + bs.map(function (b) {
      var parcial = b.estado === 'Parcial';
      var cod = esc(b.codigo);
      return '<div class="ac-bob"><div class="ac-bob-top"><strong>' + cod + '</strong>' +
        (b.nueva ? ' <span class="und">nueva</span>' : '') + (parcial ? ' <span class="ex-estado BAJO">Parcial</span>' : '') +
        '<span class="ac-kg">' + fmtNum(b.kg, 0) + ' kg' + (parcial ? ' <span class="und">de ' + fmtNum(b.pesoKg, 0) + '</span>' : '') + '</span></div>' +
        '<div class="rec-meta"><strong>📍 ' + esc(sedeCorta(b.sede)) + '</strong> · Cal ' + esc(b.calibre) + ' · G' + esc(b.grado) + ' · ' +
        esc(b.galvanizado) + ' · ' + esc(b.proveedor) + ' · ingresó ' + esc(fechaCorta(b.fechaIngreso)) + '</div>' +
        '<div class="ac-acc">' +
        '<button class="btn btn-ghost btn-sm" data-bob="Parcial" data-cod="' + cod + '" data-kg="' + esc(b.kg) + '">Parcial</button>' +
        '<button class="btn btn-ghost btn-sm" data-bob="Consumido" data-cod="' + cod + '">Consumida</button>' +
        '<button class="btn btn-ghost btn-sm" data-bob="Descartado" data-cod="' + cod + '">Descartar</button>' +
        (otrasSedes(b).length ? '<button class="btn btn-ghost btn-sm" data-tras="' + cod + '" data-sede="' + esc(b.sede) + '">' +
          (otrasSedes(b).length === 1 ? 'Pasar a ' + esc(sedeCorta(otrasSedes(b)[0])) : 'Trasladar') + '</button>' : '') +
        '</div></div>';
    }).join('') + '</div>';
  }

  function nuevoClientId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function hoyBogota() {
    return new Date(Date.now() - 5 * 3600e3).toISOString().substring(0, 10);
  }

  // ── Producido sin remisión (11-nov) ─────────────────────────────────────
  var AVISO_PR = {
    ANTES_DEL_SISTEMA: 'Terminó antes de las remisiones del sistema: si salió, regístrala como remisión antigua',
    REMISIONES_SIN_ENVIO: 'El proyecto tiene remisiones sin envío asignado: una puede ser de este',
    SIN_KG: 'La cotización no tiene KG: no se puede valorizar',
  };

  /**
   * La lista de lo producido que sigue en planta al corte. Arriba, lo que se
   * suma al inventario; las filas con aviso van resaltadas y cuentan aparte,
   * porque pueden haber salido (lo dijo la medición del 11-nov).
   */
  function producidoHtml(res) {
    var t = (res && res.totales) || {};
    var items = (res && res.items) || [];
    var precio = res && res.precioKg;
    var h = '<div class="ex-resumen">' +
      '<div class="ex-dato"><div class="v">' + fmtNum(t.envios) + '</div><div class="l">Envíos en planta</div></div>' +
      '<div class="ex-dato"><div class="v">' + fmtNum(t.kg, 0) + ' kg</div><div class="l">Acero producido</div></div>' +
      '<div class="ex-dato"><div class="v">' + (precio ? '$' + fmtNum(t.valor, 0) : '—') + '</div><div class="l">A costo</div></div>' +
      '<div class="ex-dato"><div class="v">' + (precio ? '$' + fmtNum(t.valorSinAvisos, 0) : fmtNum(t.kgSinAvisos, 0) + ' kg') + '</div>' +
      '<div class="l">Sin avisos (' + fmtNum(t.sinAvisos) + ')</div></div></div>';
    h += '<p class="inv-nota">Finalizado en Programación hasta el ' + esc(fechaCorta(res && res.corte)) +
      ' y sin remisión firme a esa fecha. Kg = los KG por casa de la cotización × lo que se produjo. ' +
      (precio ? 'Costo = kg × $' + fmtNum(precio, 0) + '/kg, el precio del acero del cierre del ' + esc(fechaCorta(res.precioCorte)) + '.'
              : 'Todavía no hay un cierre de acero: sale solo en kg.') +
      ' Las filas resaltadas pueden haber salido: revísalas en la hoja de vida del proyecto.</p>';
    if (!items.length) return h + '<div class="empty-state"><p>Nada producido sin remisión a esa fecha.</p></div>';
    h += '<div class="table-card"><div class="table-wrap"><table class="ex-tabla"><thead><tr><th>Proyecto</th><th>Envío</th>' +
      '<th>Terminó</th><th class="n">Kg</th><th class="n">Costo</th></tr></thead><tbody>' +
      items.map(function (i) {
        var avisos = (i.avisos || []).map(function (a) {
          return '<span class="pr-aviso" title="' + esc(AVISO_PR[a] || a) + '">' + esc(a === 'ANTES_DEL_SISTEMA' ? 'Antes del sistema'
            : a === 'REMISIONES_SIN_ENVIO' ? i.remSinEnvio + ' remisión(es) sin envío' : 'Sin KG') + '</span>';
        }).join('');
        return '<tr' + (avisos ? ' class="pr-revisar"' : '') + '><td><a href="proyecto.html?cb=' + encodeURIComponent(i.consecutivo) + '" target="_blank" rel="noopener">' +
          '<strong>CB' + esc(i.consecutivo) + '</strong></a> ' + esc(i.proyecto) + (avisos ? '<div>' + avisos + '</div>' : '') + '</td>' +
          '<td>' + esc(i.envio) + (i.casas && i.casas !== 1 ? ' <span class="und">(' + fmtNum(i.casas, 2) + ' casas)</span>' : '') + '</td>' +
          '<td>' + esc(fechaCorta(i.fechaFin)) + '</td>' +
          '<td class="n">' + (i.avisos.indexOf('SIN_KG') >= 0 ? '—' : fmtNum(i.kg, 0)) + '</td>' +
          '<td class="n">' + (i.valor == null || i.avisos.indexOf('SIN_KG') >= 0 ? '—' : '$' + fmtNum(i.valor, 0)) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    return h;
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
  var _exCategoria = '';   // el botón de categoría elegido en Existencias ('' = todas)
  var _acero = null;       // la pestaña Acero, pedida al abrirla (25-nov)
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
  // ── Registrar acero (25-nov) ─────────────────────────────────────────────
  var _modo = '';   // '' = accesorios · 'ACERO' = bobinas
  var ACERO_DEF = { calibre: [18, 20, 22], grado: [33, 40, 50], galvanizado: ['Z-180', 'Z-275', 'ZAM'] };
  function aceroCfg() { return (_lista && _lista.acero) || { desde: '', conocidos: ACERO_DEF, puedeNuevo: false }; }
  function opcionesHtml(valores, elegido, puedeNuevo) {
    var vs = (valores || []).map(String);
    if (elegido && vs.indexOf(String(elegido)) === -1) vs.push(String(elegido));
    return '<option value="">—</option>' + vs.map(function (v) {
      return '<option value="' + esc(v) + '"' + (String(elegido) === v ? ' selected' : '') + '>' + esc(v) + '</option>';
    }).join('') + (puedeNuevo ? '<option value="__otro">Otro…</option>' : '');
  }
  function filaBobinaHtml(prev) {
    var c = aceroCfg(), k = c.conocidos || ACERO_DEF, p = prev || {};
    var sel = function (campo) {
      return '<div><label>' + { calibre: 'Calibre', grado: 'Grado', galvanizado: 'Galvanizado' }[campo] + '</label>' +
        '<select data-campo="' + campo + '">' + opcionesHtml(k[campo], p[campo], c.puedeNuevo) + '</select></div>';
    };
    return '<div class="rec-bobina">' +
      '<div class="rec-cod"><label>Código</label><input type="text" data-campo="codigo" autocomplete="off" placeholder="factura-nº, p. ej. 1560-05" value="' +
        esc(p.codigo ? siguienteCodigo(p.codigo) : '') + '"></div>' +
      sel('calibre') + sel('grado') + sel('galvanizado') +
      '<div><label>Peso neto (kg)</label><input type="text" inputmode="decimal" data-campo="pesoKg"></div>' +
      '<div><label>$ por kg</label><input type="text" inputmode="decimal" data-campo="precioKg" value="' + esc(p.precioKg || '') + '"></div>' +
      '<button type="button" class="rec-quitar" data-quitar title="Quitar la bobina" aria-label="Quitar la bobina">✕</button></div>';
  }
  function leerBobinas() {
    return Array.prototype.map.call(document.querySelectorAll('#recBobinas .rec-bobina'), function (f) {
      var v = function (k) { return f.querySelector('[data-campo="' + k + '"]').value; };
      return { codigo: v('codigo'), calibre: v('calibre'), grado: v('grado'), galvanizado: v('galvanizado'),
               pesoKg: v('pesoKg'), precioKg: v('precioKg') };
    });
  }
  function agregarBobina() {
    var previas = leerBobinas();
    $('recBobinas').insertAdjacentHTML('beforeend', filaBobinaHtml(previas[previas.length - 1]));
    var filas = document.querySelectorAll('#recBobinas .rec-bobina');
    var peso = filas[filas.length - 1].querySelector('[data-campo="pesoKg"]');
    if (previas.length) peso.focus();
  }
  function setModo(m) {
    _modo = m || '';
    Array.prototype.forEach.call(document.querySelectorAll('#recModo [data-modo]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-modo') === _modo);
    });
    $('recModoAccesorios').classList.toggle('hidden', _modo === 'ACERO');
    $('recModoAcero').classList.toggle('hidden', _modo !== 'ACERO');
    if (_modo === 'ACERO' && !document.querySelector('#recBobinas .rec-bobina')) agregarBobina();
    var c = aceroCfg();
    if (c.desde && hoyBogota() < c.desde) {
      $('recAceroNota').textContent = 'Desde el ' + c.desde + ' el acero se registra aquí. Lo que entró antes va todavía en el Excel CF-RG-ALM-001.';
    }
    pintarSedesRecepcion();
    $('recError').classList.add('hidden');
  }
  // La sede a la que llegó (26-nov): las activas de asistencia. Con una sola,
  // ya elegida; con varias, hay que elegir (no se adivina).
  function pintarSedesRecepcion() {
    var sedes = aceroCfg().sedes || [];
    var actual = $('recSede').value;
    $('recSede').innerHTML = (sedes.length > 1 ? '<option value="">Elige la sede…</option>' : '') +
      sedes.map(function (s) { return '<option value="' + esc(s) + '"' + (s === actual ? ' selected' : '') + '>' + esc(sedeCorta(s)) + '</option>'; }).join('');
  }
  function registrarAcero() {
    var f = leerFormulario();
    var c = aceroCfg();
    var v = validarAceroLocal(Object.assign({}, f, { lineas: leerBobinas() }), hoyBogota(), c.desde);
    if ((c.sedes || []).length > 1 && !$('recSede').value) v.errores.unshift('Elige a qué sede llegó el acero.');
    var caja = $('recError');
    if (v.errores.length) { caja.textContent = v.errores.join('\n'); caja.classList.remove('hidden'); return; }
    caja.classList.add('hidden');
    var envio = { clientId: f.clientId, tipo: 'ACERO', fechaIngreso: f.fechaIngreso, proveedor: f.proveedor, factura: f.factura,
                  remisionProveedor: f.remisionProveedor, ordenCompra: f.ordenCompra, observaciones: f.observaciones,
                  sede: $('recSede').value, lineas: v.lineas };
    var btn = $('btnRegistrar');
    btn.disabled = true;
    apiInvRecepcionCrear(token, envio)
      .then(function () {
        toast('Acero registrado: ' + v.lineas.length + ' bobina' + (v.lineas.length === 1 ? '' : 's') + '. Queda pendiente de aprobación.', 'success');
        limpiarFormulario();
        cargarLista();
      })
      .catch(function (e) {
        if (e && e.tipo === 'auth') { fallo(e); return; }
        caja.textContent = (e && e.message) || 'No se pudo registrar. Revisa la señal y vuelve a tocar Registrar.';
        caja.classList.remove('hidden');
      })
      .finally(function () { btn.disabled = false; });
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
    $('recBobinas').innerHTML = '';
    if (_modo === 'ACERO') agregarBobina();
    $('recError').classList.add('hidden');
    _clientId = nuevoClientId();
  }
  function registrar() {
    if (_modo === 'ACERO') { registrarAcero(); return; }
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
      pintarSedesRecepcion();
    }).catch(function (e) { fallo(e, $('recLista')); });
  }
  function aprobar(docId, tarjeta) {
    var costos = {};
    Array.prototype.forEach.call(tarjeta.querySelectorAll('[data-costo]'), function (inp) { costos[inp.getAttribute('data-costo')] = inp.value.trim(); });
    if (!window.confirm('¿Aprobar esta recepción? Suma al inventario y no se puede deshacer desde aquí.')) return;
    apiInvRecepcionAprobar(token, docId, costos)
      .then(function (r) {
        toast(r && r.tipo === 'ACERO' ? 'Aprobada: las bobinas ya están en el acero en planta.' : 'Aprobada: ya suma al inventario.', 'success');
        _acero = null;   // la vista de acero se vuelve a pedir
        return Promise.all([cargarLista(), _stock ? cargarStock() : null]);
      })
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
    if (_stock) $('exCuerpo').innerHTML = existenciasHtml(_stock, $('exFiltro').value, _exCategoria);
  }
  function cargarStock() {
    return apiInvStock(token).then(function (r) { _stock = r; pintarStock(); })
      .catch(function (e) { fallo(e, $('exCuerpo')); });
  }

  // ── Acero (25-nov) ─────────────────────────────────────────────────────
  var _acSede = '';   // la sede elegida en la pestaña Acero ('' = todas)
  function pintarAceroVista() {
    if (_acero) $('acCuerpo').innerHTML = aceroVistaHtml(_acero, $('acFiltro').value.trim().toLowerCase(), _acSede);
  }
  /** Pasar una bobina a otra sede. Con una sola sede posible, confirmar; con varias, el número. */
  function trasladarBobina(btn) {
    var cod = btn.getAttribute('data-cod') || btn.getAttribute('data-tras'), desde = btn.getAttribute('data-sede');
    var otras = ((_acero && _acero.sedesActivas) || []).filter(function (s) { return s !== desde; });
    if (!otras.length) return;
    var destino = '';
    if (otras.length === 1) {
      if (!window.confirm('¿Pasar la bobina ' + cod + ' de ' + sedeCorta(desde) + ' a ' + sedeCorta(otras[0]) + '?')) return;
      destino = otras[0];
    } else {
      var n = window.prompt('¿A qué sede pasa la bobina ' + cod + '? Escribe el número:\n' +
        otras.map(function (s, i) { return (i + 1) + ' = ' + sedeCorta(s); }).join('\n'));
      if (n == null) return;
      destino = otras[parseInt(n, 10) - 1] || '';
      if (!destino) { toast('Ese número no es de ninguna sede.', 'warning'); return; }
    }
    btn.disabled = true;
    apiInvBobinaTrasladar(token, cod, destino)
      .then(function () { toast(cod + ': ahora en ' + sedeCorta(destino) + '.', 'success'); return cargarAceroVista(); })
      .catch(function (e) { btn.disabled = false; fallo(e); });
  }
  function cargarAceroVista() {
    return apiInvAcero(token).then(function (r) { _acero = r; pintarAceroVista(); })
      .catch(function (e) { fallo(e, $('acCuerpo')); });
  }
  /** Parcial (con los kg que le quedan, estimados), Consumido o Descartado. */
  function marcarBobina(btn) {
    var estado = btn.getAttribute('data-bob'), cod = btn.getAttribute('data-cod');
    var kg = '';
    if (estado === 'Parcial') {
      kg = window.prompt('Bobina ' + cod + ': ¿cuántos kg le quedan, más o menos? (tenía ' + btn.getAttribute('data-kg') + ' kg)');
      if (kg == null) return;
      if (!(numero(kg) > 0)) { toast('Escribe los kg que le quedan.', 'warning'); return; }
    } else if (!window.confirm('¿Marcar la bobina ' + cod + ' como ' + (estado === 'Consumido' ? 'CONSUMIDA' : 'DESCARTADA') +
                               '? Sale del acero en planta.')) {
      return;
    }
    btn.disabled = true;
    apiInvBobinaMarcar(token, cod, estado, kg)
      .then(function (r) {
        toast(r.estado === 'Parcial'
          ? cod + ': Parcial, le quedan ' + fmtNum(r.kgRestante, 0) + ' kg. Imprímele su sticker nuevo.'
          : cod + ': ' + (r.estado === 'Consumido' ? 'consumida' : 'descartada') + '.', 'success');
        return cargarAceroVista();
      })
      .catch(function (e) { btn.disabled = false; fallo(e); });
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
    if (nombre === 'acero' && !_acero) cargarAceroVista();
  }

  function init() {
    $('userName').textContent = session.nombre || '';
    if (opera) {
      $('modNav').classList.remove('hidden');
      $('tabExistencias').classList.remove('hidden');
      $('tabProducido').classList.remove('hidden');
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
    // Acero (25-nov)
    $('recModo').addEventListener('click', function (e) {
      var b = e.target.closest('[data-modo]');
      if (b) setModo(b.getAttribute('data-modo'));
    });
    $('btnAgregarBobina').addEventListener('click', agregarBobina);
    $('recBobinas').addEventListener('click', function (e) {
      var q = e.target.closest('[data-quitar]');
      if (!q) return;
      q.closest('.rec-bobina').remove();
      if (!document.querySelector('#recBobinas .rec-bobina')) agregarBobina();
    });
    $('recBobinas').addEventListener('change', function (e) {
      // "Otro…" (solo Dirección): un material nuevo. El servidor lo vuelve a validar.
      if (e.target.tagName !== 'SELECT' || e.target.value !== '__otro') return;
      var nuevo = window.prompt('¿Qué ' + ({ calibre: 'calibre', grado: 'grado', galvanizado: 'galvanizado' }[e.target.getAttribute('data-campo')]) + ' es?');
      if (!nuevo || !nuevo.trim()) { e.target.value = ''; return; }
      var o = document.createElement('option');
      o.value = nuevo.trim().toUpperCase(); o.textContent = o.value;
      e.target.insertBefore(o, e.target.lastChild);
      e.target.value = o.value;
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
    $('exCuerpo').addEventListener('click', function (e) {
      var b = e.target.closest('[data-cat]');
      if (!b) return;
      _exCategoria = b.getAttribute('data-cat');
      pintarStock();
    });

    // Acero (25-nov)
    $('btnRefrescarAc').addEventListener('click', cargarAceroVista);
    $('acFiltro').addEventListener('input', pintarAceroVista);
    $('acCuerpo').addEventListener('click', function (e) {
      var b = e.target.closest('[data-bob]');
      if (b) { marcarBobina(b); return; }
      var t = e.target.closest('[data-tras]');
      if (t) { trasladarBobina(t); return; }
      var s = e.target.closest('[data-acsede]');
      if (s) { _acSede = s.getAttribute('data-acsede'); pintarAceroVista(); }
    });

    $('prCorte').value = hoyBogota();
    $('btnProducido').addEventListener('click', function () {
      var b = $('btnProducido'), cuerpo = $('prCuerpo');
      b.disabled = true;
      cuerpo.innerHTML = '<div class="empty-state"><p>Calculando…</p></div>';
      apiInvProducidoSinRemision(token, $('prCorte').value)
        .then(function (r) { cuerpo.innerHTML = producidoHtml(r); })
        .catch(function (e) { fallo(e, cuerpo); })
        .finally(function () { b.disabled = false; });
    });

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
    // Llegó desde el QR de un sticker: directo a esa bobina, con sus botones.
    if (bobinaQR) { $('acFiltro').value = bobinaQR; mostrarTab('acero'); }
  }
  init();
})();
