// COLFRAME — Módulo Producción (Fase 1)
// Requiere: api.js (getSession, clearSession, apiProd*)

(function () {
  // ── Session check ────────────────────────────────────────
  const session = getSession();
  if (!session || !session.token) {
    window.location.replace('index.html');
    return;
  }
  const { token } = session;
  const esAdmin = !!session.esAdmin;

  // ── Estado del módulo ────────────────────────────────────
  let proyectosData  = [];
  let proyectoActual = null;

  // ── DOM refs ─────────────────────────────────────────────
  const vistaLista    = document.getElementById('vistaLista');
  const vistaDetalle  = document.getElementById('vistaDetalle');
  const modNav        = document.getElementById('modNav');
  const adminBar      = document.getElementById('adminBar');
  const bodyProyectos = document.getElementById('bodyProyectos');
  const logoutBtn     = document.getElementById('logoutBtn');

  // ── Init ─────────────────────────────────────────────────
  function init() {
    if (esAdmin) {
      modNav?.classList.remove('hidden');
      // adminBar tiene display:flex inline pero también hidden; remover hidden lo muestra
      if (adminBar) {
        adminBar.classList.remove('hidden');
        adminBar.style.display = 'flex';
      }
    }
    bindEventos();
    cargarProyectos();
    if (esAdmin) cargarAnomalias();
  }

  // ── Carga lista ──────────────────────────────────────────
  async function cargarProyectos() {
    const anio   = document.getElementById('filtroAnio').value;
    const mes    = document.getElementById('filtroMes').value;
    const estado = document.getElementById('filtroEstado').value;
    const filtros = {};
    if (anio)   filtros.anio   = anio;
    if (mes)    filtros.mes    = mes;
    if (estado) filtros.estado = estado;

    bodyProyectos.innerHTML =
      '<div style="text-align:center;padding:56px 24px;grid-column:1/-1;">' +
      '<span class="spinner" style="border-color:rgba(0,0,0,0.1);border-top-color:var(--cf-blue);"></span>' +
      '</div>';
    try {
      const res  = await apiProdProyectosList(token, filtros);
      proyectosData = res.proyectos || [];
      renderProyectos(proyectosData);
    } catch (e) {
      manejarError(e, 'cargar proyectos');
      bodyProyectos.innerHTML =
        '<p style="text-align:center;padding:48px;grid-column:1/-1;color:var(--cf-error);font-weight:600;">Error al cargar proyectos.</p>';
    }
  }

  // ── Estado en Programación (cola/producción/finalizado) ──────────────────
  // Cierra el hueco de que Producción no supiera nada del flujo. Solo admin
  // (el backend devuelve `cola: null` para el resto).
  var _MESES_COR = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  function _fechaCorta(iso) {
    if (!iso) return '—';
    var p = String(iso).substring(0, 10).split('-');
    if (p.length < 3) return '—';
    return parseInt(p[2]) + ' ' + (_MESES_COR[parseInt(p[1]) - 1] || p[1]);
  }
  // Resume las unidades de una carpeta en un solo estado legible.
  function _resumenCola(cola) {
    if (!cola || !cola.unidades || !cola.unidades.length) return null;
    var us = cola.unidades;
    var enProd = us.filter(function (u) { return u.enProduccion && u.seccion === 'cola'; });
    var enCola = us.filter(function (u) { return u.seccion === 'cola'; });
    var fin    = us.filter(function (u) { return u.seccion === 'finalizada'; });
    var back   = us.filter(function (u) { return u.seccion === 'backlog'; });
    var txt, cls, det = '';
    if (enProd.length)      { txt = 'En producción'; cls = 'prod'; det = 'desde ' + _fechaCorta(enProd[0].fechaRealInicio); }
    else if (enCola.length) { txt = 'En cola';       cls = 'cola'; det = _fechaCorta(enCola[0].inicio) + ' → ' + _fechaCorta(enCola[0].fin); }
    else if (back.length)   { txt = 'Sin cola';      cls = 'back'; }
    else                    { txt = 'Finalizado';    cls = 'fin';  det = _fechaCorta(fin[0].fechaReal); }
    // Si está partido en envíos, decir en cuántos va
    if (us.length > 1) det += (det ? ' · ' : '') + us.length + ' envíos';
    if (us.some(function (u) { return u.atrasado; })) cls += ' atraso';
    return { txt: txt, cls: cls, det: det, cb: cola.consecutivo, proyecto: cola.proyecto, notas: cola.notas, unidades: us };
  }
  // Detalle: una línea por unidad/envío, con su estado y fechas.
  function renderColaDetalle(cola) {
    const card = document.getElementById('colaCard');
    const body = document.getElementById('colaBody');
    if (!card) return;
    const r = _resumenCola(cola);
    if (!r) { card.style.display = 'none'; return; }
    card.style.display = '';
    document.getElementById('colaCardTitulo').innerHTML =
      esc(r.proyecto) + ' <span style="font-weight:400;color:var(--cf-gray-text);">CB' + esc(r.cb) + '</span>';
    const nota = r.notas ? '<div style="font-size:0.78rem;color:#7C3AED;font-style:italic;padding:0 20px 8px;">📝 ' + esc(r.notas) + '</div>' : '';
    const ETIQ = { cola: 'En cola', backlog: 'Sin cola', finalizada: 'Finalizado' };
    body.innerHTML = nota + r.unidades.map(function (u) {
      const nombre = u.esEnvio ? ('Envío ' + u.envioIdx + '/' + u.enviosTotal) : 'Proyecto completo';
      const est = u.enProduccion && u.seccion === 'cola' ? 'En producción' : (ETIQ[u.seccion] || u.seccion);
      let fechas;
      if (u.seccion === 'finalizada') fechas = 'Real: ' + (u.fechaRealInicio ? _fechaCorta(u.fechaRealInicio) + ' → ' : '') + _fechaCorta(u.fechaReal);
      else if (u.seccion === 'backlog') fechas = 'sin programar';
      else fechas = _fechaCorta(u.inicio) + ' → ' + _fechaCorta(u.fin);
      const atraso = u.atrasado ? '<span style="font-size:0.65rem;font-weight:800;color:#fff;background:#DC2626;padding:1px 6px;border-radius:999px;">Atrasado</span>' : '';
      const notaE = u.notaEnvio ? '<div style="font-size:0.72rem;color:#0891B2;font-style:italic;">📝 ' + esc(u.notaEnvio) + '</div>' : '';
      return '<div class="arch-row">' +
        '<div class="arch-info" style="flex-direction:column;align-items:flex-start;gap:1px;">' +
          '<span style="font-weight:700;font-size:0.78rem;">' + esc(nombre) + ' · ' + esc(est) + '</span>' +
          '<span style="font-size:0.73rem;color:var(--cf-gray-text);">' + esc(fechas) +
            (u.fechaEntrega ? ' · entrega ' + esc(_fechaCorta(u.fechaEntrega)) : '') + '</span>' + notaE +
        '</div>' +
        '<div class="arch-meta">' + (u.mlTotal ? u.mlTotal.toFixed(0) + ' ML ' : '') + atraso + '</div>' +
        '</div>';
    }).join('');
  }

  function badgeCola(p) {
    var r = _resumenCola(p.cola);
    if (!r) return '';
    return '<div class="cola-info ' + r.cls + '" title="' + esc(r.proyecto + ' · CB' + r.cb) + '">' +
      '<strong>' + esc(r.txt) + '</strong>' + (r.det ? ' · ' + esc(r.det) : '') +
      ' <span class="cb">CB' + esc(r.cb) + '</span></div>';
  }

  // ── Anomalías del escaneo (solo admin, solo lectura) ──────
  // Vista de AnomaliasScan (hoy invisible salvo el conteo en el toast del
  // escaneo). El backend ya deduplica por (tipo+ruta) a la ocurrencia más
  // reciente, así que esto es "problemas vigentes", no un log crudo repetido.
  var TIPO_ANOMALIA_LABEL = {
    CARPETA_FECHA:     'Nombre de carpeta',
    NOMBRE_NO_PARSEA:  'Archivo sin parsear',
  };
  async function cargarAnomalias() {
    try {
      const res = await apiProdAnomaliasList(token);
      renderAnomalias(res.anomalias || []);
    } catch (e) {
      manejarError(e, 'cargar anomalías');
    }
  }
  function renderAnomalias(lista) {
    const card  = document.getElementById('anomaliasCard');
    const count = document.getElementById('anomaliasCount');
    const body  = document.getElementById('anomaliasBody');
    if (!lista.length) { card.style.display = 'none'; return; }
    card.style.display = '';
    count.textContent  = lista.length;
    body.innerHTML = lista.map(function (a) {
      const label = TIPO_ANOMALIA_LABEL[a.tipo] || a.tipo;
      return '<div class="arch-row">' +
        '<div class="arch-info">' +
          '<span class="arch-perfil" style="background:#FEF3C7;color:#92400E;">' + esc(label) + '</span>' +
          '<span class="arch-nombre" title="' + esc(a.ruta) + '">' + esc(a.ruta) + '</span>' +
        '</div>' +
        '<div class="arch-meta">' + esc(a.detalle) + ' · ' + _fechaES(a.ts) + '</div>' +
        '</div>';
    }).join('');
  }

  // ── Render lista ─────────────────────────────────────────
  function renderProyectos(list) {
    const metros = list.reduce(function (s, p) { return s + (p.metrosTotal || 0); }, 0);
    document.getElementById('sumProyectos').textContent = list.length;
    document.getElementById('sumMetros').textContent    = metros.toFixed(1) + ' m';

    if (list.length === 0) {
      bodyProyectos.innerHTML =
        '<div class="empty-state" style="grid-column:1/-1;"><p>No hay proyectos con los filtros seleccionados.</p></div>';
      return;
    }

    bodyProyectos.innerHTML = list.map(function (p) {
      const capasHtml = Object.entries(p.resumenCapas || {}).map(function ([capa, m]) {
        return '<span style="' + estiloCapaBadge(capa) + '">' + esc(capa) + ' ' + m + 'm</span>';
      }).join('');
      const fecha = _fechaES(p.fecha);
      return '<div class="proy-card' + (p.estado === 'CERRADO' ? ' cerrado' : '') +
        '" data-id="' + esc(p.carpetaId) + '" tabindex="0" role="button" aria-label="Ver proyecto ' + esc(p.nombre) + '">' +
        '<div class="proy-card-top">' +
          '<div class="proy-nombre">' + esc(p.nombre) + '</div>' +
          '<span class="estado-badge ' + esc(p.estado) + '">' + esc(p.estado) + '</span>' +
        '</div>' +
        '<div class="proy-fecha">' + fecha + '</div>' +
        badgeCola(p) +
        '<div class="proy-capas">' + (capasHtml ||
          '<span style="font-size:0.75rem;color:var(--cf-gray-text);">Sin archivos EP2</span>') +
        '</div>' +
        '<div class="proy-footer">' +
          '<span class="proy-metros-total">' + (p.metrosTotal || 0).toFixed(1) + ' m</span>' +
          (p.anomalia ? '<span title="' + esc(p.anomalia) + '">⚠️</span>' : '') +
        '</div>' +
        '</div>';
    }).join('');

    bodyProyectos.querySelectorAll('.proy-card').forEach(function (card) {
      function handler() { abrirDetalle(card.dataset.id); }
      card.addEventListener('click', handler);
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
      });
    });
  }

  // ── Detalle ──────────────────────────────────────────────
  async function abrirDetalle(carpetaId) {
    vistaLista.classList.add('hidden');
    vistaDetalle.classList.remove('hidden');
    document.getElementById('detalleNombre').textContent = '…';
    document.getElementById('detalleAnomalia').classList.add('hidden');
    document.getElementById('detalleCapas').innerHTML = '';
    document.getElementById('detalleTotalMetros').textContent = '—';
    document.getElementById('detalleBody').innerHTML =
      '<div style="text-align:center;padding:40px;">' +
      '<span class="spinner" style="border-color:rgba(0,0,0,0.1);border-top-color:var(--cf-blue);"></span>' +
      '</div>';

    try {
      const res = await apiProdProyectoDetalle(token, carpetaId);
      proyectoActual = res.proyecto;
      renderDetalle(res.proyecto, res.archivos || [], res.cola || null);
    } catch (e) {
      manejarError(e, 'cargar detalle');
      document.getElementById('detalleBody').innerHTML =
        '<p style="padding:32px;text-align:center;color:var(--cf-error);font-weight:600;">Error al cargar el proyecto.</p>';
    }
  }

  function cerrarDetalle() {
    vistaDetalle.classList.add('hidden');
    vistaLista.classList.remove('hidden');
    proyectoActual = null;
  }

  function renderDetalle(p, archivos, cola) {
    document.getElementById('detalleNombre').textContent = p.nombre;
    renderColaDetalle(cola);

    const btnDrive = document.getElementById('btnDrive');
    btnDrive.href  = 'https://drive.google.com/drive/folders/' + p.carpetaId;

    const anomDiv = document.getElementById('detalleAnomalia');
    if (p.anomalia) {
      anomDiv.textContent = '⚠️ ' + p.anomalia;
      anomDiv.classList.remove('hidden');
    }

    const btnEstado = document.getElementById('btnEstado');
    if (esAdmin) {
      btnEstado.classList.remove('hidden');
      btnEstado.textContent        = p.estado === 'ACTIVO' ? 'Cerrar proyecto' : 'Reactivar proyecto';
      btnEstado.dataset.estado     = p.estado;
      btnEstado.dataset.carpetaId  = p.carpetaId;
    }

    document.getElementById('detalleTotalMetros').textContent =
      (p.metrosTotal || 0).toFixed(1) + ' m lineales';

    const capasEntries = Object.entries(p.resumenCapas || {});
    document.getElementById('detalleCapas').innerHTML = capasEntries.length
      ? capasEntries.map(function ([capa, m]) {
          return '<span style="' + estiloCapaBadge(capa) + ';font-size:0.82rem;padding:4px 12px;">' +
            esc(capa) + ' <span style="font-weight:400;margin-left:4px;">' + m + ' m</span></span>';
        }).join('')
      : '<span style="color:var(--cf-gray-text);font-size:0.85rem;">Sin metros EP2 registrados.</span>';

    if (archivos.length === 0) {
      document.getElementById('detalleBody').innerHTML =
        '<div class="empty-state"><p>No hay archivos registrados para este proyecto.</p></div>';
      return;
    }

    // Agrupar por capa
    const grupos = {};
    archivos.forEach(function (a) {
      const g = a.capa || 'OTRO';
      if (!grupos[g]) grupos[g] = [];
      grupos[g].push(a);
    });
    const ORDEN = ['RT', 'W', 'S', 'R', 'C', 'ENSAMBLE', 'OTRO'];
    const capas = ORDEN.filter(function (c) { return grupos[c]; })
      .concat(Object.keys(grupos).filter(function (c) { return ORDEN.indexOf(c) === -1; }));

    document.getElementById('detalleBody').innerHTML = capas.map(function (capa, idx) {
      const items = grupos[capa];
      const filas = items.map(function (a) {
        const meta = a.parseOk
          ? '<span class="arch-perfil">' + esc(a.perfil || '—') + '</span> L' + esc(a.nivel) +
            ' · ' + (a.metros || 0).toFixed(2) + ' m · ' + esc(a.acero || '—')
          : '<span style="color:var(--cf-gray-text);font-size:0.73rem;">sin parsear</span>';
        return '<div class="arch-row">' +
          '<div class="arch-info">' +
            '<span style="' + estiloCapaMini(capa) + '">' + esc(capa) + '</span>' +
            '<span class="arch-nombre" title="' + esc(a.nombre) + '">' + esc(a.nombre) + '</span>' +
          '</div>' +
          '<div class="arch-meta">' + meta + '</div>' +
          '</div>';
      }).join('');
      const sep = idx > 0 ? '<hr style="border:none;border-top:1px solid var(--cf-gray-mid);">' : '';
      return sep +
        '<div class="detalle-section">' +
          '<div class="detalle-section-title">' + esc(capa) +
            ' <span style="font-weight:400;text-transform:none;letter-spacing:0;">(' + items.length + ' archivos)</span>' +
          '</div>' +
          '<div class="arch-list">' + filas + '</div>' +
        '</div>';
    }).join('');
  }

  // ── Colores capas ────────────────────────────────────────
  const CAPA_COLORS = {
    W:        { bg: '#DBEAFE', fg: '#1D4ED8', dark: '#1D4ED8' },
    R:        { bg: '#D1FAE5', fg: '#065F46', dark: '#065F46' },
    RT:       { bg: '#FEF3C7', fg: '#92400E', dark: '#92400E' },
    C:        { bg: '#EDE9FE', fg: '#5B21B6', dark: '#5B21B6' },
    S:        { bg: '#CFFAFE', fg: '#155E75', dark: '#155E75' },
    ENSAMBLE: { bg: '#F1F5F9', fg: '#475569', dark: '#475569' },
  };
  function estiloCapaBadge(capa) {
    const c = CAPA_COLORS[capa] || { bg: '#F3F4F6', fg: '#374151' };
    return 'background:' + c.bg + ';color:' + c.fg +
      ';font-size:0.72rem;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap;display:inline-block;';
  }
  function estiloCapaMini(capa) {
    const c = CAPA_COLORS[capa] || { dark: '#374151' };
    return 'background:' + c.dark + ';color:#fff;font-size:0.65rem;font-weight:700;' +
      'padding:1px 5px;border-radius:4px;flex-shrink:0;white-space:nowrap;';
  }

  // ── Eventos ──────────────────────────────────────────────
  function bindEventos() {
    logoutBtn?.addEventListener('click', function () {
      clearSession();
      window.location.replace('index.html');
    });

    document.getElementById('btnBuscar')?.addEventListener('click', cargarProyectos);

    ['filtroAnio', 'filtroMes', 'filtroEstado'].forEach(function (id) {
      document.getElementById(id)?.addEventListener('change', cargarProyectos);
    });

    document.getElementById('btnVolverLista')?.addEventListener('click', cerrarDetalle);

    document.getElementById('btnScanNow')?.addEventListener('click', async function () {
      const btn = this;
      btn.disabled    = true;
      btn.textContent = 'Escaneando…';
      try {
        const res = await apiProdScanNow(token);
        toast('Scan completado: ' + res.actualizados + ' proyectos actualizados, ' + res.anomalias + ' anomalías.', 'success');
        await cargarProyectos();
        await cargarAnomalias();
      } catch (e) {
        manejarError(e, 'scan manual');
      } finally {
        btn.disabled    = false;
        btn.textContent = '🔄 Escanear Drive';
      }
    });

    document.getElementById('btnAnomaliasRefrescar')?.addEventListener('click', cargarAnomalias);

    document.getElementById('btnEstado')?.addEventListener('click', async function () {
      if (!proyectoActual) return;
      const nuevoEstado = proyectoActual.estado === 'ACTIVO' ? 'CERRADO' : 'ACTIVO';
      const ok = await confirmar(
        nuevoEstado === 'CERRADO' ? 'Cerrar proyecto' : 'Reactivar proyecto',
        '¿Confirmas cambiar el estado de "' + proyectoActual.nombre + '" a ' + nuevoEstado + '?'
      );
      if (!ok) return;
      try {
        await apiProdProyectoEstado(token, proyectoActual.carpetaId, nuevoEstado);
        toast('Estado actualizado a ' + nuevoEstado + '.', 'success');
        proyectoActual.estado = nuevoEstado;
        const btn = document.getElementById('btnEstado');
        btn.textContent    = nuevoEstado === 'ACTIVO' ? 'Cerrar proyecto' : 'Reactivar proyecto';
        btn.dataset.estado = nuevoEstado;
      } catch (e) {
        manejarError(e, 'cambiar estado');
      }
    });
  }

  // ── Utilidades (locales — los de admin.js están en su IIFE) ──
  var _MESES_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  function _fechaES(iso) {
    if (!iso) return '—';
    var p = iso.substring(0, 10).split('-');
    if (p.length < 2) return iso;
    var mes  = _MESES_ES[parseInt(p[1]) - 1] || p[1];
    var anio = p[0];
    return (p[2] ? parseInt(p[2]) + ' ' + mes : mes) + ' ' + anio;
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toast(msg, tipo) {
    tipo = tipo || 'info';
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const PALETA = {
      info:    { bg: '#1E40AF', icon: 'ℹ️' },
      success: { bg: '#065F46', icon: '✅' },
      warning: { bg: '#92400E', icon: '⚠️' },
      error:   { bg: '#B91C1C', icon: '❌' },
    };
    const c = PALETA[tipo] || PALETA.info;
    const el = document.createElement('div');
    el.style.cssText =
      'background:' + c.bg + ';color:#fff;padding:12px 16px;border-radius:10px;' +
      'font-size:0.85rem;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.22);' +
      'pointer-events:auto;display:flex;align-items:center;gap:8px;' +
      'animation:slideIn 0.25s ease;max-width:320px;line-height:1.4;';
    el.innerHTML = '<span>' + c.icon + '</span><span>' + esc(msg) + '</span>';
    container.appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }

  function confirmar(titulo, mensaje) {
    return new Promise(function (resolve) {
      const overlay = document.getElementById('modalConfirmProd');
      document.getElementById('confirmProdTitle').textContent = titulo;
      document.getElementById('confirmProdMsg').textContent   = mensaje;
      overlay.classList.remove('hidden');
      function cleanup(result) {
        overlay.classList.add('hidden');
        document.getElementById('confirmProdOk').removeEventListener('click', onOk);
        document.getElementById('confirmProdCancel').removeEventListener('click', onCancel);
        resolve(result);
      }
      function onOk()     { cleanup(true);  }
      function onCancel() { cleanup(false); }
      document.getElementById('confirmProdOk').addEventListener('click', onOk);
      document.getElementById('confirmProdCancel').addEventListener('click', onCancel);
    });
  }

  function manejarError(e, ctx) {
    if (e && e.tipo === 'auth') {
      clearSession();
      window.location.replace('index.html');
      return;
    }
    toast((e && e.message) || 'Error al ' + ctx + '.', 'error');
    console.error('[produccion] ' + ctx, e);
  }

  // ── Arrancar ─────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
