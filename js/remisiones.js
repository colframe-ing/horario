// ============================================================
// remisiones.js — Módulo de Remisiones (Fase 1)
// ============================================================
//
//  ┌─ VISTA LISTA    Tabla con filtros + aviso de borradores por conciliar
//  └─ VISTA EDITOR   Cabecera + ítems + cajas, con el flujo de estados
//
// FLUJO (maker-checker):
//   BORRADOR ──enviar──► POR_CONCILIAR ──admin concilia──► DESPACHADA
//                              └────admin devuelve────┘
//   El consecutivo RM- se asigna al CONCILIAR, no al crear: si cada borrador
//   tomara número, los abandonados dejarían huecos en la numeración.
//
// DEPENDENCIAS: config.js · api.js
// ============================================================

(function () {
  'use strict';

  const session = getSession();
  if (!session || !session.token) { window.location.replace('index.html'); return; }
  const token = session.token;

  // ── Estado del módulo ──
  let M = { productos: [], clientes: [], nitsSinCliente: [], esAdmin: false, yo: null };
  let prodIdx = {};        // idProducto -> producto
  let cliIdx  = {};        // codCliente -> cliente (con sus nits)
  let doc = null;          // remisión abierta { ...cabecera, _detalle, _cajas, _puedeEditar }
  // Filas de _detalle cuya descripción está en edición TEMPORAL (se muestra el
  // input; al terminar vuelve a verse como texto). Es estado de UI, no del
  // documento — por eso se limpia entera ante cualquier cambio de estructura
  // (agregar/quitar/mover línea), para no quedar apuntando a la fila que ya
  // no es la misma tras el reordenamiento.
  let editandoDesc = new Set();
  let proyectosCache = [];
  // Cambios sin guardar en el editor. Se usa para avisar antes de salir sin
  // guardar (botón Volver) o cerrar/recargar la pestaña (beforeunload). Se
  // marca por delegación desde #vistaEditor (input/change burbujean incluso
  // desde las filas de la tabla de ítems, que se reconstruyen en cada render)
  // y a mano en las acciones que no disparan esos eventos (agregar/quitar
  // línea, aceptar sugerencia de peso).
  let dirty = false;
  function marcarSucio() { dirty = true; }

  const $ = (id) => document.getElementById(id);

  // ============================================================
  // UTILIDADES
  // ============================================================

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

  // ── Campos con buscador (input + datalist) ──────────────────────────────────
  // Las opciones se escriben como "CODIGO · Descripción" para que el filtro del
  // navegador encuentre por cualquiera de los dos: buscar "holdown" o "IN-002"
  // llega al mismo ítem. Un <select> con 357 clientes es imposible de recorrer.
  const SEP = ' · ';

  /** Extrae el código de lo que quedó escrito en el campo. Tolera que el usuario
   *  haya escrito solo el código, o el texto completo elegido de la lista. */
  function codDe(valor) {
    const s = String(valor || '').trim();
    if (!s) return '';
    const i = s.indexOf(SEP);
    return (i > 0 ? s.slice(0, i) : s).trim();
  }

  /** Rellena un <datalist> con [{cod, texto}]. */
  function poblarDatalist(idLista, items) {
    const dl = $(idLista);
    if (!dl) return;
    dl.innerHTML = items.map(it =>
      `<option value="${esc(it.cod + SEP + it.texto)}"></option>`).join('');
  }

  /** Texto completo "COD · Desc" a partir de un código, para mostrar al cargar
   *  una remisión existente. Si el código ya no está en el catálogo, se deja
   *  como está en vez de borrarlo: el dato histórico manda. */
  function textoDe(items, cod) {
    if (!cod) return '';
    const it = items.find(x => String(x.cod) === String(cod));
    return it ? it.cod + SEP + it.texto : String(cod);
  }
  function fmtNum(v, d) {
    const n = num(v);
    return n ? n.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: d == null ? 2 : d }) : '—';
  }
  function hoyISO() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); }

  function toast(msg, tipo = 'info', dur = 3500) {
    const c = { info: ['#EFF6FF', '#1E40AF', 'ℹ'], success: ['#F0FDF4', '#15803D', '✓'],
                warning: ['#FFFBEB', '#A16207', '⚠'], error: ['#FEF2F2', '#B91C1C', '✕'] }[tipo]
             || ['#EFF6FF', '#1E40AF', 'ℹ'];
    const d = document.createElement('div');
    d.style.cssText = `pointer-events:auto;background:${c[0]};color:${c[1]};border:1px solid ${c[1]}33;` +
      'border-radius:10px;padding:12px 16px;min-width:240px;max-width:380px;font-size:0.86rem;' +
      'font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,.08);display:flex;gap:10px;';
    d.innerHTML = '<span>' + c[2] + '</span><span style="flex:1;">' + esc(msg) + '</span>';
    $('toastContainer').appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .3s'; }, dur - 300);
    setTimeout(() => d.remove(), dur);
  }

  function manejarError(e, ctx) {
    console.error(ctx, e);
    const msg = (e && e.name === 'ApiError') ? e.message : 'Ocurrió un error inesperado.';
    if (e && e.tipo === 'auth') {
      toast(msg + ' Vuelve a iniciar sesión.', 'error', 4000);
      setTimeout(() => { clearSession(); window.location.replace('index.html'); }, 1500);
      return;
    }
    toast(msg, 'error', 5000);
  }

  /** Confirmación. pedirMotivo=true muestra un input y resuelve con el texto. */
  function confirmar({ titulo = 'Confirmar', mensaje, btnOk = 'Confirmar', peligro = false, pedirMotivo = false }) {
    return new Promise(resolve => {
      $('confirmTitle').textContent = titulo;
      $('confirmMsg').textContent = mensaje;
      $('confirmInputWrap').classList.toggle('oculto', !pedirMotivo);
      $('confirmInput').value = '';
      const ok = $('confirmOk'), cancel = $('confirmCancel'), modal = $('modalConfirm');
      ok.textContent = btnOk;
      ok.style.background = peligro ? '#DC2626' : '';
      ok.style.borderColor = peligro ? '#DC2626' : '';
      modal.classList.remove('hidden');
      if (pedirMotivo) setTimeout(() => $('confirmInput').focus(), 50);
      const cerrar = (val) => {
        modal.classList.add('hidden'); ok.onclick = null; cancel.onclick = null;
        resolve(val);
      };
      ok.onclick = () => cerrar(pedirMotivo ? ($('confirmInput').value.trim() || '(sin motivo)') : true);
      cancel.onclick = () => cerrar(false);
    });
  }

  // ============================================================
  // ARRANQUE
  // ============================================================

  // Asignaciones tolerantes: si a la plantilla le falta un id opcional, no debe
  // tumbarse el módulo entero. Antes un $('userName') inexistente lanzaba y la
  // lista nunca se pintaba.
  function txt(id, valor) { const el = $(id); if (el) el.textContent = valor; }
  function onClick(id, fn) { const el = $(id); if (el) el.addEventListener('click', fn); }

  txt('userName', session.nombre || '');
  onClick('logoutBtn', async () => {
    if (await confirmar({ titulo: 'Cerrar sesión', mensaje: '¿Cerrar tu sesión actual?', btnOk: 'Cerrar sesión' })) {
      clearSession(); window.location.replace('index.html');
    }
  });

  // 'input' y 'change' burbujean hasta #vistaEditor incluso desde inputs
  // dentro de la tabla de ítems, que se reconstruye en cada render — por eso
  // basta un único listener puesto una vez, en vez de reatarlo cada vez.
  $('vistaEditor').addEventListener('input', marcarSucio);
  $('vistaEditor').addEventListener('change', marcarSucio);

  // Cubre cerrar la pestaña, recargar o navegar a otro módulo con un enlace
  // (eso descarga la página; Volver no — por eso ese botón se confirma aparte).
  window.addEventListener('beforeunload', (e) => {
    if (!dirty || $('vistaEditor').classList.contains('oculto')) return;
    e.preventDefault();
    e.returnValue = '';
  });

  async function cargarMaestros(refrescar) {
    const res = await apiRemMaestros(token, refrescar);
    M = res;
    prodIdx = {}; cliIdx = {};
    (M.productos || []).forEach(p => { prodIdx[p.id] = p; });
    (M.clientes || []).forEach(c => { cliIdx[c.cod] = c; });
    poblarBuscadores();
  }

  (async function init() {
    try { await cargarMaestros(); } catch (e) { manejarError(e, 'maestros'); }

    const hoy = hoyISO();
    $('fHasta').value = hoy;
    $('fDesde').value = hoy.slice(0, 8) + '01';
    cargarLista();
  })();

  // El catálogo (productos/clientes/municipios) se cachea 6 h en el backend
  // (ver remMaestros en Remisiones.gs) para no releer las hojas en cada carga.
  // Sin este botón, un cliente o producto nuevo no aparecía hasta que el
  // caché expirara solo.
  onClick('btnRefrescarCatalogo', async () => {
    const btn = $('btnRefrescarCatalogo');
    btn.disabled = true; btn.textContent = 'Actualizando…';
    try {
      await cargarMaestros(true);
      toast('Catálogo actualizado.', 'success');
    } catch (e) { manejarError(e, 'maestros'); }
    finally { btn.disabled = false; btn.textContent = '↻ Catálogo'; }
  });

  // Listas de los tres buscadores. Se arman una vez al cargar los maestros.
  let itemsClientes = [], itemsProductos = [], itemsMunicipios = [];

  function poblarBuscadores() {
    // String(...) por si `nombre`/`desc` llega como número desde la hoja (una
    // celda con solo dígitos, p.ej. si un pegado corrido puso el código de
    // cliente en la columna del nombre): sin esto, .localeCompare() no existe
    // en un number y el error tumbaba TODO el catálogo, no solo esa fila.
    itemsClientes = (M.clientes || [])
      .map(c => ({ cod: c.cod, texto: String(c.nombre || '(sin nombre)') }))
      .sort((a, b) => a.texto.localeCompare(b.texto));
    poblarDatalist('listaClientes', itemsClientes);

    itemsProductos = (M.productos || [])
      .map(p => ({ cod: p.id, texto: String(p.desc || '') }))
      .sort((a, b) => a.texto.localeCompare(b.texto));
    poblarDatalist('listaProductos', itemsProductos);

    // Llegan compactos: '05001|Medellín|Antioquia'
    itemsMunicipios = (M.municipios || []).map(s => {
      const p = String(s).split('|');
      return { cod: p[0], texto: p[1] + (p[2] ? ', ' + p[2] : '') };
    });
    poblarDatalist('listaMunicipios', itemsMunicipios);
  }

  // ============================================================
  // VISTA: LISTADO
  // ============================================================

  $('btnBuscar').addEventListener('click', cargarLista);
  $('fBuscar').addEventListener('keydown', e => { if (e.key === 'Enter') cargarLista(); });
  $('fEstado').addEventListener('change', cargarLista);
  $('fDesde').addEventListener('change', cargarLista);
  $('fHasta').addEventListener('change', cargarLista);
  // El backend ignora Desde/Hasta cuando hay texto en Buscar (remList en
  // Remisiones.gs) — quien busca un consecutivo no piensa en de qué mes es.
  // Se avisa acá para que no parezca que el filtro de fecha sigue aplicando.
  $('fBuscar').addEventListener('input', () => {
    const activo = !!$('fBuscar').value.trim();
    ['fDesde', 'fHasta'].forEach(id => {
      $(id).style.opacity = activo ? '0.45' : '';
      $(id).title = activo ? 'Ignorado mientras haya texto en Buscar' : '';
    });
  });

  async function cargarLista() {
    $('bodyLista').innerHTML = '<tr><td colspan="9" class="empty">Cargando…</td></tr>';
    try {
      const res = await apiRemList(token, {
        estado: $('fEstado').value, desde: $('fDesde').value,
        hasta: $('fHasta').value, buscar: $('fBuscar').value.trim(),
      });
      renderLista(res.remisiones || []);
      renderAlerta(res.resumen || {});
    } catch (e) {
      manejarError(e, 'lista');
      $('bodyLista').innerHTML = '<tr><td colspan="9" class="empty">No se pudo cargar.</td></tr>';
    }
  }

  /** Aviso de borradores esperando conciliación. Sin esto la cola se acumula
   *  invisible y salen despachos físicos sin documento firme. */
  function renderAlerta(r) {
    const el = $('alertaConciliar');
    if (!r.porConciliar) { el.classList.add('oculto'); return; }
    let extra = '';
    if (r.masAntiguaPorConciliar) {
      const dias = Math.floor((new Date(hoyISO()) - new Date(r.masAntiguaPorConciliar)) / 86400000);
      if (dias >= 2) extra = ` La más antigua lleva <strong>${dias} días</strong> esperando.`;
    }
    el.innerHTML = `<span>⚠</span><span><strong>${r.porConciliar}</strong> remisión(es) esperando conciliación.${extra}</span>` +
      '<button class="btn btn-primary btn-sm" id="btnVerPend">Ver</button>';
    el.classList.remove('oculto');
    $('btnVerPend').onclick = () => { $('fEstado').value = 'POR_CONCILIAR'; cargarLista(); };
  }

  function renderLista(rows) {
    if (!rows.length) {
      $('bodyLista').innerHTML = '<tr><td colspan="9" class="empty">Sin remisiones para el filtro.</td></tr>';
      return;
    }
    $('bodyLista').innerHTML = rows.map(r => {
      const consec = r.consecutivo
        ? `<span class="rem-consec">${esc(r.consecutivo)}</span>`
        : '<span class="rem-consec sin">sin numerar</span>';
      return `<tr data-doc="${esc(r.docId)}">
        <td>${consec}</td>
        <td>${esc(r.fecha)}</td>
        <td><span class="rem-badge ${esc(r.estado)}">${esc(String(r.estado).replace('_', ' '))}</span></td>
        <td>${esc(r.razonSocial || r.codCliente || '—')}</td>
        <td>${esc(r.destinatario || '—')}<div style="font-size:0.72rem;color:var(--cf-gray-text);">${esc(r.municipio || '')}</div></td>
        <td>${esc(r.proyecto || '—')}${r.cb ? `<div style="font-size:0.72rem;color:var(--cf-gray-text);">CB ${esc(r.cb)}</div>` : ''}</td>
        <td class="rem-num">${fmtNum(r.pesoTotalKg)}</td>
        <td class="rem-num">${r.nCajas || '—'}</td>
        <td style="text-align:right;"><button class="btn btn-ghost btn-sm btn-abrir">Abrir</button></td>
      </tr>`;
    }).join('');
    $('bodyLista').querySelectorAll('.btn-abrir').forEach(b => {
      b.onclick = () => abrirRemision(b.closest('tr').dataset.doc);
    });
  }

  // ============================================================
  // VISTA: EDITOR
  // ============================================================

  function mostrarVista(cual) {
    $('vistaLista').classList.toggle('oculto', cual !== 'lista');
    $('vistaEditor').classList.toggle('oculto', cual !== 'editor');
    if (cual === 'lista') window.scrollTo(0, 0);
  }

  /** Confirma si hay cambios sin guardar. Si no hay nada pendiente, resuelve
   *  true de inmediato sin mostrar el modal. */
  async function confirmarDescartar() {
    if (!dirty) return true;
    return await confirmar({
      titulo: 'Salir sin guardar',
      mensaje: 'Hay cambios sin guardar en esta remisión. Si sales ahora se pierden.',
      btnOk: 'Salir sin guardar', peligro: true,
    });
  }

  $('btnVolver').addEventListener('click', async () => {
    if (!await confirmarDescartar()) return;
    dirty = false;
    mostrarVista('lista'); cargarLista();
  });
  $('btnNueva').addEventListener('click', () => nuevaRemision());

  function nuevaRemision() {
    // Se prellena con los ítems típicos (marca `frecuente` del catálogo, ver
    // FASE0_CATALOGO.md §1: aparecen en la mayoría de los despachos). Solo la
    // cantidad y el peso quedan vacíos — es lo que cambia en cada envío.
    // _precargado=true: si queda así, sin cantidad, guardar() la quita sola
    // en vez de bloquear con un error — el checklist original (FASE0 §umbral)
    // era "aparece, se descarta si no aplica", no "hay que borrarla a mano".
    const detalle = (M.productos || []).filter(p => p.frecuente).map(p => ({
      idProducto: p.id, _libre: false, descripcion: p.desc, unidad: p.und || '',
      cantidad: '', pesoKg: '', cajaNum: '', _precargado: true,
    }));
    doc = { docId: '', estado: 'BORRADOR', fecha: hoyISO(), _detalle: detalle, _cajas: [], _puedeEditar: true };
    editandoDesc.clear();
    dirty = false;
    pintarEditor();
    mostrarVista('editor');
    if (detalle.length) toast(`Precargados ${detalle.length} ítems típicos. Escribe cantidad a los que apliquen — los demás se descartan solos al guardar.`, 'info', 5000);
  }

  async function abrirRemision(docId) {
    try {
      const res = await apiRemDetalle(token, docId);
      doc = Object.assign({}, res.remision, {
        _detalle: res.detalle || [], _cajas: res.cajas || [], _puedeEditar: !!res.puedeEditar,
      });
      editandoDesc.clear();
      dirty = false;
      pintarEditor();
      mostrarVista('editor');
    } catch (e) { manejarError(e, 'detalle'); }
  }

  function pintarEditor() {
    const nuevo = !doc.docId;
    const est = String(doc.estado || 'BORRADOR').toUpperCase();
    $('edTitulo').innerHTML = nuevo
      ? 'Nueva remisión'
      : `${esc(doc.consecutivo || 'Borrador')} <span class="rem-badge ${esc(est)}" style="vertical-align:middle;margin-left:8px;">${esc(est.replace('_', ' '))}</span>`;

    // Campos
    const set = (id, v) => { const el = $(id); if (el) el.value = v == null ? '' : v; };
    set('edFecha', doc.fecha || hoyISO());
    set('edCb', doc.cb); set('edVersion', doc.version); set('edProyecto', doc.proyecto);
    // Los buscadores muestran "CÓDIGO · Descripción"; el código real vive en doc.
    set('edCliente', textoDe(itemsClientes, doc.codCliente));
    pintarNits(doc.codCliente, doc.nit);
    set('edRazon', doc.razonSocial); set('edDireccion', doc.direccion);
    set('edCiudad', doc.ciudad); set('edTelefono', doc.telefono);
    set('edDestinatario', doc.destinatario); set('edDirEnvio', doc.direccionEnvio);
    set('edContacto', doc.contacto); set('edTelDestino', doc.telefonoDestino);
    set('edMunicipio', doc.codDane ? textoDe(itemsMunicipios, doc.codDane) : (doc.municipio || ''));
    set('edOrdenCompra', doc.ordenCompra); set('edNoContrato', doc.noContrato);
    set('edRepresentante', doc.representanteComercial); set('edDoctoAlt', doc.doctoAlt);
    set('edConductor', doc.conductor); set('edCedCond', doc.cedulaConductor);
    set('edPlaca', doc.placa); set('edTelCond', doc.telefonoConductor);
    set('edTransportadora', doc.transportadora);
    set('edObservaciones', doc.observaciones);

    renderLineas();

    // Banner de estado
    const banner = $('edEstadoBanner');
    if (est === 'POR_CONCILIAR') {
      banner.innerHTML = '<span>⏳</span><span>Esperando conciliación de un administrador. ' +
        'Mientras esté así, <strong>no es un documento válido para despacho</strong>.</span>';
      banner.classList.remove('oculto');
    } else if (doc.motivoRechazo) {
      banner.innerHTML = '<span>↩</span><span>Devuelta: <strong>' + esc(doc.motivoRechazo) + '</strong></span>';
      banner.classList.remove('oculto');
    } else {
      banner.classList.add('oculto');
    }

    // Botones según estado y permisos
    const editable = doc._puedeEditar !== false;
    const puedeEnviar = editable && est === 'BORRADOR' && !nuevo;
    const puedeConciliar = M.esAdmin && (est === 'BORRADOR' || est === 'POR_CONCILIAR') && !nuevo;
    $('btnGuardar').classList.toggle('oculto', !editable);
    $('btnEnviar').classList.toggle('oculto', !puedeEnviar);
    $('btnConciliar').classList.toggle('oculto', !puedeConciliar);
    $('btnRechazar').classList.toggle('oculto', !(M.esAdmin && est === 'POR_CONCILIAR'));
    $('btnAnular').classList.toggle('oculto', !(M.esAdmin && !nuevo && est !== 'ANULADA'));
    $('btnImprimir').classList.toggle('oculto', nuevo);
    $('btnSugerir').classList.toggle('oculto', !(editable && doc.cotizacionArchivo));

    // Campos de solo lectura cuando ya no se puede editar
    $('vistaEditor').querySelectorAll('input,select,textarea').forEach(el => {
      if (el.id === 'edProyBuscar') return;
      el.disabled = !editable && el.tagName !== 'BUTTON';
    });
  }

  // ── Cliente / NIT (relación 1:N) ─────────────────────────────
  // El campo es un buscador, así que se resuelve el código desde el texto.
  // Si lo escrito no corresponde a ningún cliente, se avisa en vez de fallar
  // en silencio: quedarse con un cliente inválido rompería la remisión al guardar.
  $('edCliente').addEventListener('change', () => {
    const cod = codDe($('edCliente').value);
    const c = cliIdx[cod];
    const aviso = $('edNitAviso');
    ocultarFormNitNuevo();
    if (!cod) { pintarNits('', ''); return; }
    if (!c) {
      $('edNit').innerHTML = '<option value="">— Cliente no reconocido —</option>';
      aviso.textContent = 'No encontré ese cliente. Elige uno de la lista o escribe su código.';
      aviso.classList.remove('oculto');
      $('btnNitNuevo').classList.add('oculto');
      return;
    }
    // Normalizo lo escrito al formato canónico "COD · Nombre".
    $('edCliente').value = textoDe(itemsClientes, cod);
    pintarNits(cod, '');
    $('edCiudad').value = c.ciudad || '';
    if (c.nits && c.nits.length === 1) aplicarNit(c.nits[0]);
  });

  // Municipio: guarda el nombre visible y el código DANE aparte, que es lo que
  // la facturación electrónica necesita.
  $('edMunicipio').addEventListener('change', () => {
    const cod = codDe($('edMunicipio').value);
    const m = itemsMunicipios.find(x => x.cod === cod);
    doc.codDane = m ? m.cod : '';
    if (m) $('edMunicipio').value = m.cod + SEP + m.texto;
  });

  function pintarNits(cod, nitSel) {
    const c = cliIdx[cod];
    const sel = $('edNit'), aviso = $('edNitAviso');
    // El botón de agregar una entidad nueva depende solo de tener un cliente
    // resuelto (cod válido) — con o sin NITs previos. Un cliente como un fondo
    // que agrupa muchos constructores puede necesitar agregar el primero.
    $('btnNitNuevo').classList.toggle('oculto', !cod || doc._puedeEditar === false);
    if (!c || !c.nits || !c.nits.length) {
      sel.innerHTML = '<option value="">— Sin entidades registradas —</option>';
      aviso.textContent = cod ? 'Este cliente no tiene NIT registrado. Escribe la razón social a mano, o agrégala con "+ Nuevo".' : '';
      aviso.classList.toggle('oculto', !cod);
      return;
    }
    sel.innerHTML = c.nits.map(n =>
      `<option value="${esc(n.nit)}"${String(n.nit) === String(nitSel) ? ' selected' : ''}>` +
      `${esc(n.nit)} · ${esc(n.razon)}${n.principal ? ' (principal)' : ''}</option>`).join('');
    // Varios RUT: hay clientes que piden factura a una entidad distinta.
    if (c.nits.length > 1) {
      aviso.textContent = `Este cliente factura a ${c.nits.length} entidades. Verifica cuál corresponde.`;
      aviso.classList.remove('oculto');
    } else {
      aviso.classList.add('oculto');
    }
    const actual = c.nits.find(n => String(n.nit) === String(nitSel)) || c.nits.find(n => n.principal) || c.nits[0];
    if (actual && !nitSel) aplicarNit(actual);
  }

  $('edNit').addEventListener('change', () => {
    // $('edCliente').value es "COD · Nombre", no el código — hay que extraerlo
    // con codDe() igual que en todos los demás usos de este campo. Sin esto,
    // cliIdx[...] siempre daba undefined y elegir otro NIT no actualizaba
    // razón social/dirección, justo en los clientes con varios RUT que es el
    // caso que motivó tener la relación 1:N.
    const c = cliIdx[codDe($('edCliente').value)];
    const n = c && (c.nits || []).find(x => String(x.nit) === $('edNit').value);
    if (n) aplicarNit(n);
  });

  function aplicarNit(n) {
    $('edNit').value = n.nit;
    $('edRazon').value = n.razon || '';
    if (n.dir) $('edDireccion').value = n.dir;
    if (n.ciudad) $('edCiudad').value = n.ciudad;
  }

  // ── Agregar entidad de facturación nueva (NIT/razón social) ──────────────
  // Casos como un cliente-fondo que agrupa muchos constructores: cada despacho
  // puede facturar a una entidad que todavía no está en el catálogo. Se agrega
  // aquí mismo, sin salir del formulario ni esperar a que alguien la precargue
  // en la hoja de clientes.
  function ocultarFormNitNuevo() {
    $('edNitNuevoForm').classList.add('oculto');
    ['edNitNuevoNit', 'edNitNuevoRazon', 'edNitNuevoDireccion', 'edNitNuevoCiudad'].forEach(id => { $(id).value = ''; });
  }

  onClick('btnNitNuevo', () => {
    const abierto = !$('edNitNuevoForm').classList.contains('oculto');
    if (abierto) { ocultarFormNitNuevo(); return; }
    $('edNitNuevoForm').classList.remove('oculto');
    $('edNitNuevoNit').focus();
  });
  onClick('btnNitNuevoCancelar', ocultarFormNitNuevo);

  onClick('btnNitNuevoGuardar', async () => {
    const cod = codDe($('edCliente').value);
    const c = cliIdx[cod];
    if (!c) { toast('Selecciona primero un cliente reconocido.', 'warning'); return; }
    const nit = $('edNitNuevoNit').value.trim();
    const razonSocial = $('edNitNuevoRazon').value.trim();
    if (!nit) { toast('Falta el NIT o CC.', 'warning'); $('edNitNuevoNit').focus(); return; }
    if (!razonSocial) { toast('Falta la razón social.', 'warning'); $('edNitNuevoRazon').focus(); return; }

    const btn = $('btnNitNuevoGuardar');
    btn.disabled = true; btn.textContent = 'Agregando…';
    try {
      const res = await apiRemClienteNitAgregar(token, cod, {
        nit, razonSocial,
        direccion: $('edNitNuevoDireccion').value.trim(),
        ciudad: $('edNitNuevoCiudad').value.trim(),
      });
      // El catálogo se cachea 6 h en el backend: sin refrescar, la entidad
      // recién agregada no aparecería en el select hasta que expire solo.
      await cargarMaestros(true);
      pintarNits(cod, res.nit);
      // pintarNits() solo llama aplicarNit() cuando NO se pide un nit puntual
      // (para no pisar el snapshot de una remisión ya guardada al reabrirla,
      // ver pintarEditor). Aquí SÍ hay que aplicarlo a mano: es una entidad
      // recién creada y sus campos (razón social, dirección, ciudad) todavía
      // no están en ningún lado del formulario.
      const nuevo = ((cliIdx[cod] || {}).nits || []).find(n => String(n.nit) === String(res.nit));
      if (nuevo) aplicarNit(nuevo);
      ocultarFormNitNuevo();
      marcarSucio();
      toast(res.yaExistia ? 'Esa entidad ya existía — seleccionada.' : 'Entidad agregada y seleccionada.', 'success');
    } catch (e) { manejarError(e, 'nit-nuevo'); }
    finally { btn.disabled = false; btn.textContent = 'Agregar entidad'; }
  });

  // ── Selector de cotización ───────────────────────────────────
  let tProy = null;
  $('edProyBuscar').addEventListener('input', () => {
    clearTimeout(tProy);
    tProy = setTimeout(buscarProyectos, 300);
  });

  async function buscarProyectos() {
    const q = $('edProyBuscar').value.trim();
    const sel = $('edProySelect');
    if (q.length < 2) { sel.style.display = 'none'; return; }
    try {
      const res = await apiRemProyectos(token, q);
      proyectosCache = res.proyectos || [];
      if (!proyectosCache.length) {
        sel.innerHTML = '<option disabled>Sin resultados</option>';
      } else {
        sel.innerHTML = proyectosCache.map((p, i) =>
          `<option value="${i}">CB ${esc(p.cb)}.${esc(p.version)} · ${esc(p.proyecto)} · ${fmtNum(p.mlTotal)} ml` +
          `${p.cantidad > 1 ? ' · ' + p.cantidad + ' casas' : ''}</option>`).join('');
      }
      sel.style.display = 'block';
    } catch (e) { manejarError(e, 'proyectos'); }
  }

  $('edProySelect').addEventListener('change', () => {
    const p = proyectosCache[parseInt($('edProySelect').value)];
    if (!p) return;
    $('edCb').value = p.cb; $('edVersion').value = p.version;
    $('edProyecto').value = p.proyecto;
    doc.cotizacionArchivo = p.archivo;
    $('edProySelect').style.display = 'none';
    $('edProyBuscar').value = '';
    $('btnSugerir').classList.remove('oculto');
    toast('Proyecto vinculado: CB ' + p.cb + '.' + p.version, 'success');
  });

  // ── Sugerir detalle desde la cotización (§6.1.2 del plan) ────────────────
  // El backend ya multiplicó por número de casas y restó lo despachado en
  // remisiones firmes anteriores del mismo archivo; aquí solo se fusiona con
  // lo que ya haya en la tabla SIN pisar nada que el usuario haya escrito.
  $('btnSugerir').addEventListener('click', async () => {
    if (!doc.cotizacionArchivo) return;
    const btn = $('btnSugerir');
    btn.disabled = true; btn.textContent = 'Consultando…';
    try {
      const res = await apiRemSugerir(token, doc.cotizacionArchivo, doc.docId);
      const lineas = res.lineas || [];
      if (!lineas.length) { toast('La cotización no tiene nada que sugerir.', 'info'); return; }
      marcarSucio();

      let nuevas = 0, actualizadas = 0, sinMapeo = 0;
      lineas.forEach(sug => {
        if (sug.sinMapeo) sinMapeo++;
        // Si el código no existe en el catálogo real, se agrega como línea
        // libre (con la referencia visible) en vez de perder el dato: es mejor
        // que quien despacha vea "REF_PLANTILLA_X" y decida, que no verlo.
        if (!sug.idProducto) {
          doc._detalle.push({
            idProducto: '', _libre: true,
            descripcion: `[código no reconocido: ${sug.descripcion || '?'}]`,
            unidad: sug.unidad || 'Un', cantidad: sug.cantidadSugerida || '',
            pesoKg: '', cajaNum: '',
          });
          nuevas++;
          return;
        }
        const existente = doc._detalle.find(l => String(l.idProducto) === String(sug.idProducto));
        if (existente) {
          // No se pisa un valor que el usuario ya puso: cantidad y peso solo se
          // completan si están vacíos. pesoSugeridoKg sí se guarda siempre, para
          // que se vea la desviación aunque el usuario ya haya escrito un peso.
          if (existente.cantidad === '' || existente.cantidad == null) existente.cantidad = sug.cantidadSugerida;
          if (sug.pesoSugeridoKg != null) existente.pesoSugeridoKg = sug.pesoSugeridoKg;
          actualizadas++;
        } else {
          const p = prodIdx[sug.idProducto];
          doc._detalle.push({
            idProducto: sug.idProducto, _libre: false,
            descripcion: sug.descripcion || (p ? p.desc : ''),
            unidad: sug.unidad || (p ? p.und : ''),
            cantidad: sug.cantidadSugerida || '',
            pesoKg: '', pesoSugeridoKg: sug.pesoSugeridoKg, pesoFuente: 'SUGERIDO',
            cajaNum: '',
          });
          nuevas++;
        }
      });

      renderLineas();
      const detFuente = res.fuente === 'remision_detalle' ? 'la remisión de la cotización' : 'los accesorios de la cotización';
      toast(`Sugeridas ${nuevas} línea(s) nueva(s) y ${actualizadas} completada(s), desde ${detFuente}` +
            (sinMapeo ? ` · ${sinMapeo} con código no reconocido (revísalas)` : '') +
            (res.cantidadCasas > 1 ? ` · × ${res.cantidadCasas} casas` : ''),
            sinMapeo ? 'warning' : 'success', 6000);
    } catch (e) { manejarError(e, 'sugerir'); }
    finally { btn.disabled = false; btn.textContent = 'Sugerir desde la cotización'; }
  });

  // ============================================================
  // ÍTEMS
  // ============================================================

  /** HTML del indicador de sugerencia/desviación de peso de la línea `i`.
   *  Extraído de renderLineas() para poder reusarlo en refrescarFilaVisual()
   *  sin reconstruir toda la fila. */
  function filaSugHtml(l, i) {
    if (l.pesoSugeridoKg && num(l.pesoSugeridoKg) > 0) {
      const d = num(l.pesoKg) - num(l.pesoSugeridoKg);
      return num(l.pesoKg) > 0
        ? `<div class="desv ${Math.abs(d) > num(l.pesoSugeridoKg) * 0.05 ? 'alta' : 'ok'}">${d >= 0 ? '+' : ''}${fmtNum(d)} vs sug.</div>`
        : `<div><span class="sug-chip" data-sug="${i}">usar ${fmtNum(l.pesoSugeridoKg)}</span></div>`;
    }
    if (l.pesoFuente === 'CALCULADO_UNITARIO' && num(l.pesoKg) > 0) {
      // Peso propuesto = cantidad × peso unitario de planta (ver
      // remCargarPesosUnitarios). Se marca como estimado porque no es una
      // pesada real: si se pesa la caja y difiere, basta con corregir el
      // campo — al tocarlo pasa a MANUAL y este aviso desaparece solo.
      return `<div class="desv" style="color:var(--cf-gray-text);font-style:italic;">≈ calculado</div>`;
    }
    return '';
  }

  /** Aplica el chip de "usar sugerido" de la línea `i`, sea que venga del
   *  render completo o de refrescarFilaVisual(). */
  function aceptarSugerido(i) {
    doc._detalle[i].pesoKg = doc._detalle[i].pesoSugeridoKg;
    doc._detalle[i].pesoFuente = 'SUGERIDO_ACEPTADO';
    marcarSucio();
    const pesoInput = $('bodyLineas').querySelector(`input[data-f="pesoKg"][data-i="${i}"]`);
    if (pesoInput) pesoInput.value = doc._detalle[i].pesoKg;
    refrescarFilaVisual(i);
    actualizarTotales();
  }

  /** Actualiza SOLO los indicadores derivados (peso obligatorio, desviación)
   *  de la fila `i`, sin reconstruir el <tr> — así no se pierde el foco ni
   *  la posición del cursor cuando se está tabulando por la tabla. Reemplaza
   *  el renderLineas() completo que antes se disparaba en cada 'change' de
   *  cualquier campo: como ese evento dispara al salir del campo (blur), para
   *  cuando corría el navegador ya intentaba enfocar el siguiente input, que
   *  el renderLineas() completo acababa de destruir — el foco se perdía y
   *  capturar con teclado se volvía imposible en una tabla de 14+ líneas. */
  function refrescarFilaVisual(i) {
    const l = doc._detalle[i];
    const tb = $('bodyLineas');
    if (!l || !tb) return;
    const pesoInput = tb.querySelector(`input[data-f="pesoKg"][data-i="${i}"]`);
    if (!pesoInput) return;
    // No se pisa el valor mientras el usuario está tecleando justo ahí: se
    // movería el cursor. Sí se sincroniza cuando el cambio vino de OTRO campo
    // (p.ej. autoPesoSiAplica al escribir la cantidad).
    if (document.activeElement !== pesoInput) {
      const val = l.pesoKg == null ? '' : l.pesoKg;
      if (String(pesoInput.value) !== String(val)) pesoInput.value = val;
    }
    const p = l.idProducto ? prodIdx[l.idProducto] : null;
    const kitSinPeso = p && p.tipo === 'KIT' && !(num(l.pesoKg) > 0);
    pesoInput.classList.toggle('peso-req', !!kitSinPeso);
    pesoInput.title = kitSinPeso ? 'Obligatorio: es el dato que se factura' : '';

    // El indicador (desviación / chip / "≈ calculado") vive como hermano del
    // input dentro de la misma celda — se quita el anterior y se reinserta.
    const td = pesoInput.parentElement;
    let sib = pesoInput.nextElementSibling;
    while (sib) { const n = sib.nextElementSibling; sib.remove(); sib = n; }
    const html = filaSugHtml(l, i);
    if (html) {
      const wrap = document.createElement('div');
      wrap.innerHTML = html;
      const nodo = wrap.firstElementChild;
      td.appendChild(nodo);
      const chip = nodo.querySelector('.sug-chip');
      if (chip) chip.onclick = () => aceptarSugerido(i);
    }
  }

  function renderLineas() {
    const tb = $('bodyLineas');
    if (!doc._detalle.length) {
      tb.innerHTML = '<tr><td colspan="7" class="empty" style="padding:20px;">Sin ítems. Agrega uno abajo.</td></tr>';
      actualizarTotales();
      return;
    }
    tb.innerHTML = doc._detalle.map((l, i) => {
      // Una línea es LIBRE si se creó como tal (_libre === true), o si viene del
      // backend (_libre undefined) sin producto pero con descripción.
      // El caso `_libre === false` es explícito y NUNCA se infiere: si no, al
      // rechazar un producto inválido la línea se convertía en libre porque
      // conservaba la descripción del producto anterior.
      const libre = (l._libre === true) ||
                    (l._libre === undefined && !l.idProducto && !!l.descripcion);
      const p = l.idProducto ? prodIdx[l.idProducto] : null;
      const kitSinPeso = p && p.tipo === 'KIT' && !(num(l.pesoKg) > 0);
      // Buscador (no <select>): se escribe parte del código o de la descripción
      // y el navegador filtra. Con 66 productos y una tabla con scroll, un
      // desplegable nativo es incómodo y se recorta.
      // Para un ítem del catálogo, por defecto solo se ve el buscador — el
      // seleccionable. La descripción (lo que sale impreso) aparece debajo
      // como texto, con un lápiz que la abre para editar TEMPORALMENTE: al
      // confirmar (✓) vuelve a ser solo texto. Así "KIT ESTRUCTURAL" se puede
      // volver "KIT ESTRUCTURAL CASA 244-245-246" sin ensuciar la fila con un
      // segundo campo siempre abierto, y sin perder el vínculo con EST-001
      // (y su tipo_item = KIT, que es lo que exige el peso).
      let prodCell;
      if (libre) {
        prodCell = `<input type="text" data-f="descripcion" data-i="${i}" value="${esc(l.descripcion)}" placeholder="Descripción del ítem">`;
      } else {
        const buscador = `<input type="text" data-f="idProducto" data-i="${i}" list="listaProductos" autocomplete="off"
                  value="${esc(textoDe(itemsProductos, l.idProducto))}" placeholder="Código o nombre…">`;
        const descLinea = editandoDesc.has(i)
          ? `<div style="display:flex;gap:4px;margin-top:4px;">
               <input type="text" data-f="descripcion" data-i="${i}" value="${esc(l.descripcion)}"
                      placeholder="Descripción" style="flex:1;font-size:0.76rem;">
               <button type="button" class="btn-icon btn-desc-ok" data-i="${i}" title="Listo">✓</button>
             </div>`
          : `<div style="display:flex;align-items:center;gap:4px;margin-top:3px;">
               <span style="flex:1;font-size:0.72rem;color:var(--cf-gray-text);font-style:italic;
                            overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(l.descripcion)}</span>
               <button type="button" class="btn-icon btn-desc-edit" data-i="${i}" title="Editar descripción">✎</button>
             </div>`;
        prodCell = buscador + descLinea;
      }
      const sug = filaSugHtml(l, i);
      return `<tr class="${libre ? 'lin-libre' : ''}">
        <td>
          <input type="number" class="orden-input" data-i="${i}" min="1" max="${doc._detalle.length}"
                 value="${i + 1}" title="Cambia el número para mover el ítem a esa posición">
        </td>
        <td>${prodCell}</td>
        <td><input type="text" data-f="unidad" data-i="${i}" value="${esc(l.unidad)}"></td>
        <td><input type="number" step="0.01" min="0" data-f="cantidad" data-i="${i}" value="${esc(l.cantidad)}"></td>
        <td><input type="number" step="0.01" min="0" data-f="pesoKg" data-i="${i}" value="${esc(l.pesoKg)}"
                   class="${kitSinPeso ? 'peso-req' : ''}"
                   title="${kitSinPeso ? 'Obligatorio: es el dato que se factura' : ''}">${sug}</td>
        <td><input type="number" step="1" min="1" data-f="cajaNum" data-i="${i}" value="${esc(l.cajaNum)}"></td>
        <td><button class="btn-icon btn-del" data-i="${i}" title="Quitar" style="color:#DC2626;">✕</button></td>
      </tr>`;
    }).join('');

    // .orden-input queda afuera: no es un campo del documento (data-f), es la
    // posición en la tabla — lo maneja reordenarLinea(), no onCambioLinea.
    tb.querySelectorAll('input:not(.orden-input),select').forEach(el => {
      el.addEventListener('change', onCambioLinea);
      if (el.tagName === 'INPUT') el.addEventListener('input', onCambioLineaSuave);
    });
    tb.querySelectorAll('.btn-del').forEach(b => {
      b.onclick = async () => {
        const i = parseInt(b.dataset.i);
        const l = doc._detalle[i];
        // Una línea vacía (precargada y sin tocar, o recién agregada) se
        // quita sin preguntar — no hay nada que perder. Con datos, sí.
        const tieneDatos = l && (num(l.cantidad) > 0 || num(l.pesoKg) > 0 || (l.descripcion && !l._precargado));
        if (tieneDatos && !await confirmar({
          titulo: 'Quitar ítem', mensaje: `¿Quitar "${l.descripcion || l.idProducto || 'este ítem'}" de la remisión?`,
          btnOk: 'Quitar', peligro: true,
        })) return;
        doc._detalle.splice(i, 1);
        editandoDesc.clear();
        marcarSucio();
        renderLineas();
      };
    });
    // Reordenar escribiendo el número destino, en vez de flechas: con listas
    // largas, mover un ítem del final al principio a golpe de clic era muy
    // engorroso. Se confirma con Enter o al salir del campo (evento 'change'),
    // no en cada tecla, para no reordenar a medio escribir un número de 2 cifras.
    tb.querySelectorAll('.orden-input').forEach(inp => {
      inp.addEventListener('change', () => reordenarLinea(parseInt(inp.dataset.i), inp.value));
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
    });
    tb.querySelectorAll('.btn-desc-edit').forEach(b => {
      b.onclick = () => {
        editandoDesc.add(parseInt(b.dataset.i));
        renderLineas();
        // El foco se pone a mano tras redibujar: el atributo autofocus no se
        // respeta de forma confiable al insertar HTML dinámicamente.
        const inp = tb.querySelector(`input[data-f="descripcion"][data-i="${b.dataset.i}"]`);
        if (inp) { inp.focus(); inp.select(); }
      };
    });
    tb.querySelectorAll('.btn-desc-ok').forEach(b => {
      b.onclick = () => { editandoDesc.delete(parseInt(b.dataset.i)); renderLineas(); };
    });
    tb.querySelectorAll('.sug-chip').forEach(c => {
      c.onclick = () => aceptarSugerido(parseInt(c.dataset.sug));
    });
    actualizarTotales();
  }

  /**
   * Propone el peso de una línea como cantidad × peso unitario de planta
   * (columna `pesoUnitarioKg` del catálogo, ver remCargarPesosUnitarios en
   * Remisiones.gs). Solo actúa si nadie ha puesto ya un peso real:
   *   - pesoFuente vacío  → primera vez que hay cantidad, se propone
   *   - pesoFuente CALCULADO_UNITARIO → ya era una propuesta; si la cantidad
   *     cambió, se recalcula
   *   - cualquier otro valor (MANUAL, SUGERIDO_ACEPTADO) → el usuario ya puso
   *     un peso con criterio propio (tecleado o de una pesada real); no se
   *     pisa. Basta con tocar el campo de peso una vez para que quede así.
   * Devuelve true si cambió algo (para saber si hay que refrescar el input).
   */
  function autoPesoSiAplica(l) {
    if (l.pesoFuente && l.pesoFuente !== 'CALCULADO_UNITARIO') return false;
    const p = l.idProducto ? prodIdx[l.idProducto] : null;
    if (!p || !(p.pesoUnitarioKg > 0)) return false;
    // El kit estructural (y cualquier ítem a medida) no tiene un peso fijo
    // por unidad — varía según el proyecto (una casa de 200 m² no pesa lo
    // mismo que una de 80). "cantidad × peso unitario" solo tiene sentido
    // para ítems de catálogo fijo (tornillos, anclajes, conectores). Si de
    // todos modos quedó un pesoUnitarioKg cargado para un EST- por error de
    // captura, esta línea evita que se proponga solo — el peso del kit sale
    // de "Sugerir desde la cotización" o se digita a mano, nunca de aquí.
    if (p.tipo === 'KIT' || p.tipo === 'A_MEDIDA') return false;
    const cant = num(l.cantidad);
    if (!(cant > 0)) {
      // Cantidad borrada: si el peso mostrado era una propuesta, se borra con
      // ella; si era manual, se deja intacto (ya se filtró arriba).
      if (l.pesoFuente === 'CALCULADO_UNITARIO') { l.pesoKg = ''; l.pesoFuente = ''; return true; }
      return false;
    }
    const nuevo = Math.round(cant * p.pesoUnitarioKg * 1000) / 1000;
    if (String(nuevo) === String(l.pesoKg)) return false;
    l.pesoKg = nuevo;
    l.pesoFuente = 'CALCULADO_UNITARIO';
    return true;
  }

  function onCambioLinea(e) {
    const i = parseInt(e.target.dataset.i), f = e.target.dataset.f;
    const l = doc._detalle[i]; if (!l) return;
    // Una línea precargada deja de ser "descartable en silencio" en cuanto
    // alguien la toca: si la tocó, la intención de usarla es explícita, y un
    // valor vacío después de eso debe volver a ser el error normal.
    if (l._precargado) delete l._precargado;

    if (f === 'idProducto') {
      // El campo trae "COD · Descripción" o lo que el usuario haya tecleado.
      const cod = codDe(e.target.value);
      const p = prodIdx[cod];
      if (!cod) { l.idProducto = ''; renderLineas(); return; }
      if (!p) {
        // No se acepta un código inexistente: el backend lo rechazaría al
        // guardar y el usuario no sabría por qué.
        toast(`No encontré el producto "${cod}". Elígelo de la lista.`, 'warning', 4500);
        l.idProducto = '';
        l.descripcion = '';   // no dejar la descripción del producto anterior
        renderLineas();
        return;
      }
      l.idProducto = cod;
      l.unidad = p.und || '';
      l.descripcion = p.desc || '';
      // Si la línea ya traía cantidad (p.ej. viene de "sugerir" o de los
      // ítems típicos) y el producto elegido tiene peso unitario, se propone
      // de una vez — no hay que esperar a retocar la cantidad.
      autoPesoSiAplica(l);
      renderLineas();
      // Elegir el producto reconstruye toda la fila (cambia descripción y
      // unidad), así que el foco se pierde igual que con cualquier re-render
      // completo. Se manda a mano al siguiente campo lógico (Cantidad) para
      // no dejar la captura colgada ahí.
      const cantInp = $('bodyLineas').querySelector(`input[data-f="cantidad"][data-i="${i}"]`);
      if (cantInp) cantInp.focus();
      avisarAcompanamiento(p);
      return;
    }

    l[f] = e.target.value;
    if (f === 'pesoKg') l.pesoFuente = 'MANUAL';
    if (f === 'cantidad') autoPesoSiAplica(l);
    // Solo idProducto necesita reconstruir la fila entera (cambia descripción,
    // unidad y buscador). Los demás campos solo afectan indicadores derivados
    // (peso obligatorio, desviación) y el total — un renderLineas() completo
    // aquí destruiría el input que el navegador está a punto de enfocar al
    // salir del campo con Tab, y el foco se perdía en toda la tabla.
    refrescarFilaVisual(i);
    actualizarTotales();
  }

  /** Actualiza totales sin re-render, para no perder el foco al teclear.
   *  Se excluye idProducto: ese se resuelve solo al confirmar (change), porque
   *  a medio escribir el texto todavía no corresponde a ningún código. */
  function onCambioLineaSuave(e) {
    const i = parseInt(e.target.dataset.i), f = e.target.dataset.f;
    if (f === 'idProducto') return;
    const l = doc._detalle[i];
    if (!l) return;
    if (l._precargado) delete l._precargado;
    l[f] = e.target.value;
    if (f === 'pesoKg') l.pesoFuente = 'MANUAL';
    if (f === 'cantidad') autoPesoSiAplica(l);
    // Se refleja en vivo mientras se teclea, sin renderLineas() completo (eso
    // le quitaría el foco al campo que se está editando) — mismo criterio que
    // ya usa actualizarTotales().
    refrescarFilaVisual(i);
    actualizarTotales();
  }

  /** Regla de acompañamiento: hay ítems que no pueden salir solos.
   *  Ej. la punta REX debe ir siempre que se envíen tornillos REX. */
  function avisarAcompanamiento(p) {
    if (!p.acompana) return;
    const req = prodIdx[p.acompana];
    if (!req) return;
    const ya = doc._detalle.some(l => String(l.idProducto) === String(p.acompana));
    if (ya) return;
    toast(`${p.desc} normalmente va con ${req.desc}. Considera agregarlo.`, 'warning', 6000);
  }

  function actualizarTotales() {
    let peso = 0, faltan = 0;
    doc._detalle.forEach(l => {
      peso += num(l.pesoKg);
      const p = l.idProducto ? prodIdx[l.idProducto] : null;
      if (p && p.tipo === 'KIT' && !(num(l.pesoKg) > 0)) faltan++;
    });
    // En el total sí se muestra 0: un guión ahí se lee como "sin dato".
    $('edPesoTotal').textContent = peso ? fmtNum(peso) : '0';
    const av = $('edPesoAviso');
    if (faltan) {
      av.textContent = `Falta el peso en kg de ${faltan} línea(s) de kit estructural. ` +
                       'Es el dato que se factura, así que no se puede guardar sin él.';
      av.classList.remove('oculto');
    } else { av.classList.add('oculto'); }
    renderCajasResumen();
  }

  function renderCajasResumen() {
    const cont = $('cajasResumen');
    const porCaja = {};
    doc._detalle.forEach(l => {
      const c = parseInt(l.cajaNum);
      if (c > 0) { porCaja[c] = porCaja[c] || { n: 0, peso: 0 }; porCaja[c].n++; porCaja[c].peso += num(l.pesoKg); }
    });
    const nums = Object.keys(porCaja).map(Number).sort((a, b) => a - b);
    const sinAsignar = doc._detalle.filter(l => !(parseInt(l.cajaNum) > 0)).length;
    if (!nums.length) {
      cont.innerHTML = `<span style="font-size:0.82rem;color:var(--cf-gray-text);">Ningún ítem asignado a caja${sinAsignar ? ' (' + sinAsignar + ' sin asignar)' : ''}.</span>`;
      return;
    }
    cont.innerHTML = nums.map(n =>
      `<div style="border:1px solid var(--cf-gray-mid);border-radius:8px;padding:8px 12px;font-size:0.8rem;">
        <strong>Caja ${n} de ${nums.length}</strong>
        <div style="color:var(--cf-gray-text);">${porCaja[n].n} ítem(s) · ${fmtNum(porCaja[n].peso)} kg</div>
        ${doc.docId ? `<div style="display:flex;gap:4px;margin-top:6px;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm btn-caja-pdf" data-caja="${n}" data-tipo="etiqueta" style="font-size:0.7rem;padding:3px 8px;">Etiqueta</button>
          <button class="btn btn-ghost btn-sm btn-caja-pdf" data-caja="${n}" data-tipo="manifiesto" style="font-size:0.7rem;padding:3px 8px;">Manifiesto</button>
          <label style="display:flex;align-items:center;gap:4px;font-size:0.68rem;color:var(--cf-gray-text);margin-left:2px;"
                 title="Si el contenido de esta caja no cabe en un solo bulto físico, imprime una etiqueta por bulto (Paquete 1 de N, 2 de N…)">
            en
            <input type="number" class="caja-paquetes" data-caja="${n}" min="1" max="20" value="1"
                   style="width:38px;padding:2px 4px;border:1px solid var(--cf-gray-mid);border-radius:4px;text-align:center;">
            paquete(s)
          </label>
        </div>` : ''}
      </div>`).join('') +
      (sinAsignar ? `<div style="border:1px dashed #DC2626;border-radius:8px;padding:8px 12px;font-size:0.8rem;color:#B91C1C;">
        <strong>${sinAsignar} sin asignar</strong></div>` : '');
    cont.querySelectorAll('.btn-caja-pdf').forEach(b => {
      b.onclick = () => {
        const n = parseInt(b.dataset.caja);
        // Los paquetes solo aplican a la etiqueta: el manifiesto describe el
        // contenido de la caja una sola vez, sin importar en cuántos bultos
        // físicos haya tocado repartirla.
        const paqInput = cont.querySelector(`.caja-paquetes[data-caja="${n}"]`);
        const paquetes = b.dataset.tipo === 'etiqueta' ? (parseInt(paqInput && paqInput.value) || 1) : 1;
        imprimir(b.dataset.tipo, n, paquetes);
      };
    });
  }

  // El PDF de la remisión imprime el detalle en el mismo orden en que quedó
  // guardado (RemisionDetalle.item) — no lee la asignación de cajas para
  // reordenar por su cuenta. Este botón hace ese reacomodo una sola vez, en
  // vez de mover línea por línea con el campo "#": junta todos los ítems de
  // la caja 1, luego los de la 2, etc., y deja los sin asignar al final
  // (donde ya se destacan en rojo en el resumen de cajas). Sigue haciendo
  // falta "Guardar" después para que el PDF salga en este orden — reordenar
  // no escribe la hoja por sí solo.
  onClick('btnAgruparCajas', () => {
    const conCaja = doc._detalle.filter(l => parseInt(l.cajaNum) > 0);
    const sinCaja = doc._detalle.filter(l => !(parseInt(l.cajaNum) > 0));
    if (!conCaja.length) { toast('Ningún ítem tiene caja asignada todavía.', 'info'); return; }
    // Array.prototype.sort es estable (ES2019+): dentro de la misma caja
    // conserva el orden en que se capturaron los ítems.
    conCaja.sort((a, b) => parseInt(a.cajaNum) - parseInt(b.cajaNum));
    doc._detalle = conCaja.concat(sinCaja);
    editandoDesc.clear();
    marcarSucio();
    renderLineas();
    toast('Ítems reordenados por caja. Guarda para que el PDF salga en este orden.', 'success', 4500);
  });

  /** Cambia el orden de dos líneas contiguas. El número de ítem que se guarda
   *  al final (item = i+1) sale de la posición en el arreglo, así que mover
   *  aquí es lo único que hace falta para que la remisión salga renumerada. */
  /** Mueve la línea `i` (0-based) a la posición `destino1based` (1-based, la
   *  que el usuario tecleó). Se recorta a un rango válido en vez de rechazar
   *  un número fuera de rango — es más natural que escribir "99" en una lista
   *  de 5 ítems simplemente la mande al final, y no que marque error. */
  function reordenarLinea(i, destino1based) {
    const n = doc._detalle.length;
    let destino = parseInt(destino1based, 10);
    if (!destino || destino < 1) destino = 1;
    if (destino > n) destino = n;
    const destino0 = destino - 1;
    if (destino0 === i) { renderLineas(); return; }   // sin cambio real: solo repinta el numero
    const [item] = doc._detalle.splice(i, 1);
    doc._detalle.splice(destino0, 0, item);
    editandoDesc.clear();
    renderLineas();
  }

  $('btnAddLinea').addEventListener('click', () => {
    doc._detalle.push({ idProducto: '', descripcion: '', unidad: '', cantidad: '', pesoKg: '', cajaNum: '', _libre: false });
    editandoDesc.clear();
    marcarSucio();
    renderLineas();
    const buscador = $('bodyLineas').querySelector(`input[data-f="idProducto"][data-i="${doc._detalle.length - 1}"]`);
    if (buscador) buscador.focus();
  });
  $('btnAddLibre').addEventListener('click', () => {
    doc._detalle.push({ idProducto: '', descripcion: '', unidad: 'Un', cantidad: '', pesoKg: '', cajaNum: '', _libre: true });
    editandoDesc.clear();
    marcarSucio();
    renderLineas();
    const desc = $('bodyLineas').querySelector(`input[data-f="descripcion"][data-i="${doc._detalle.length - 1}"]`);
    if (desc) desc.focus();
  });

  // ============================================================
  // GUARDAR Y CAMBIOS DE ESTADO
  // ============================================================

  function leerCabecera() {
    const v = (id) => { const el = $(id); return el ? el.value.trim() : ''; };
    return {
      docId: doc.docId || '',
      // Antes siempre era la fecha de HOY, sin campo en la UI para cambiarla:
      // una remisión documentada al día siguiente del despacho quedaba con
      // fecha equivocada y sin arreglo. Ahora es editable (mientras el estado
      // lo permita, igual que el resto del formulario).
      fecha: v('edFecha') || doc.fecha || hoyISO(),
      cotizacionArchivo: doc.cotizacionArchivo || '',
      cb: v('edCb'), version: v('edVersion'), proyecto: v('edProyecto'),
      // De los buscadores se envía el CÓDIGO, nunca el texto visible. Si lo
      // escrito no resuelve a un cliente real del catálogo, se manda vacío en
      // vez del texto tecleado — de lo contrario esa basura entra al maestro
      // que la Fase 0 acaba de limpiar. La razón social manual sigue viajando
      // igual, que es la salida que ya ofrece el aviso de "cliente no
      // reconocido" (pintarNits).
      codCliente: cliIdx[codDe(v('edCliente'))] ? codDe(v('edCliente')) : '',
      nit: v('edNit'), razonSocial: v('edRazon'),
      direccion: v('edDireccion'), ciudad: v('edCiudad'), telefono: v('edTelefono'),
      destinatario: v('edDestinatario'), direccionEnvio: v('edDirEnvio'),
      contacto: v('edContacto'), telefonoDestino: v('edTelDestino'),
      // municipio va como nombre legible (sale impreso en la remisión) y el
      // código DANE aparte, que es lo que exige la facturación electrónica.
      municipio: (function () {
        const cod = codDe(v('edMunicipio'));
        const m = itemsMunicipios.find(x => x.cod === cod);
        return m ? m.texto : v('edMunicipio');
      })(),
      codDane: (function () {
        const cod = codDe(v('edMunicipio'));
        return itemsMunicipios.some(x => x.cod === cod) ? cod : '';
      })(),
      ordenCompra: v('edOrdenCompra'), noContrato: v('edNoContrato'),
      representanteComercial: v('edRepresentante'), doctoAlt: v('edDoctoAlt'),
      conductor: v('edConductor'), cedulaConductor: v('edCedCond'),
      placa: v('edPlaca').toUpperCase(), telefonoConductor: v('edTelCond'),
      transportadora: v('edTransportadora'),
      observaciones: v('edObservaciones'),
      nCajas: new Set(doc._detalle.map(l => parseInt(l.cajaNum)).filter(n => n > 0)).size,
    };
  }

  $('btnGuardar').addEventListener('click', () => guardar());

  /** Quita del documento las líneas precargadas que nadie tocó (sin cantidad).
   *  Son los ítems "típicos" que nuevaRemision() agrega de una vez para no
   *  teclearlos siempre — si el despacho no los lleva, no debe ser el usuario
   *  quien las borre una por una para poder guardar. Devuelve cuántas quitó. */
  function quitarPrecargadasVacias() {
    const antes = doc._detalle.length;
    doc._detalle = doc._detalle.filter(l => !(l._precargado && (l.cantidad === '' || l.cantidad == null)));
    return antes - doc._detalle.length;
  }

  async function guardar(silencioso) {
    const quitadas = quitarPrecargadasVacias();
    if (quitadas) {
      editandoDesc.clear();
      renderLineas();
      toast(`${quitadas} ítem(s) típico(s) sin cantidad se omitieron (no aplican a este despacho).`, 'info', 4500);
    }
    if (!doc._detalle.length) {
      toast('Agrega al menos un ítem con cantidad antes de guardar.', 'warning');
      return false;
    }
    const btn = $('btnGuardar');
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const res = await apiRemGuardar(token, leerCabecera(), doc._detalle);
      doc.docId = res.docId;
      doc.pesoTotalKg = res.pesoTotalKg;
      dirty = false;
      if (!silencioso) toast('Borrador guardado · ' + res.lineas + ' línea(s) · ' + fmtNum(res.pesoTotalKg) + ' kg', 'success');
      pintarEditor();
      return true;
    } catch (e) { manejarError(e, 'guardar'); return false; }
    finally { btn.disabled = false; btn.textContent = 'Guardar borrador'; }
  }

  $('btnEnviar').addEventListener('click', async () => {
    if (!await guardar(true)) return;
    if (!await confirmar({
      titulo: 'Enviar a conciliar',
      mensaje: 'La remisión pasa a revisión de un administrador y ya no la podrás editar.\n\n' +
               'El número RM- se asigna cuando la concilien.',
      btnOk: 'Enviar',
    })) return;
    try {
      await apiRemEnviar(token, doc.docId);
      toast('Enviada a conciliación.', 'success');
      mostrarVista('lista'); cargarLista();
    } catch (e) { manejarError(e, 'enviar'); }
  });

  $('btnConciliar').addEventListener('click', async () => {
    if (doc._puedeEditar !== false && !await guardar(true)) return;
    if (!await confirmar({
      titulo: 'Conciliar y despachar',
      mensaje: 'Se asigna el consecutivo definitivo y se registran las salidas de inventario.\n\n' +
               'Es la transición que vuelve la remisión un documento firme.',
      btnOk: 'Conciliar',
    })) return;
    const btn = $('btnConciliar');
    btn.disabled = true; btn.textContent = 'Conciliando…';
    try {
      const res = await apiRemConciliar(token, doc.docId);
      if (res.yaConciliada) toast('Ya estaba conciliada como ' + res.consecutivo, 'info');
      else toast(`✓ ${res.consecutivo} despachada · ${res.movimientos} movimiento(s) de inventario`, 'success', 5000);
      await abrirRemision(doc.docId);
    } catch (e) { manejarError(e, 'conciliar'); }
    finally { btn.disabled = false; btn.textContent = '✓ Conciliar y despachar'; }
  });

  $('btnRechazar').addEventListener('click', async () => {
    const motivo = await confirmar({
      titulo: 'Devolver a borrador',
      mensaje: 'Vuelve a manos de quien la creó para que la corrija.',
      btnOk: 'Devolver', peligro: true, pedirMotivo: true,
    });
    if (!motivo) return;
    try {
      await apiRemRechazar(token, doc.docId, motivo);
      toast('Devuelta a borrador.', 'success');
      mostrarVista('lista'); cargarLista();
    } catch (e) { manejarError(e, 'rechazar'); }
  });

  $('btnAnular').addEventListener('click', async () => {
    const motivo = await confirmar({
      titulo: 'Anular remisión',
      mensaje: 'La remisión queda marcada como ANULADA y no se puede volver a editar. La fila no se borra, queda como registro.',
      btnOk: 'Anular', peligro: true, pedirMotivo: true,
    });
    if (!motivo) return;
    try {
      await apiRemAnular(token, doc.docId, motivo);
      toast('Remisión anulada.', 'success');
      mostrarVista('lista'); cargarLista();
    } catch (e) { manejarError(e, 'anular'); }
  });

  // ============================================================
  // IMPRESIÓN
  // ============================================================

  $('btnImprimir').addEventListener('click', () => imprimir('remision'));

  async function imprimir(tipo, caja, paquetes) {
    toast('Generando documento…', 'info', 2500);
    try {
      const res = await apiRemPdf(token, doc.docId, tipo, caja, paquetes);
      if (!res.base64) { toast('El servidor no devolvió el documento.', 'error'); return; }
      const bin = atob(res.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = res.nombre || ((doc.consecutivo || 'remision') + '.pdf');
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { manejarError(e, 'pdf'); }
  }
})();
