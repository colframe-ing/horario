// ============================================================
// COTIZACIONES — vista del maestro + marcar aprobadas
// ============================================================
(function () {
  'use strict';

  var session = getSession();
  if (!session || !session.token) { location.href = 'index.html'; return; }
  // Módulo solo-admin: las cotizaciones muestran precios y utilidad.
  if (!session.esAdmin) { location.href = 'produccion.html'; return; }
  var token   = session.token;
  var esAdmin = true;

  var _cache = [];      // última lista recibida
  var _marcando = {};   // archivo → true mientras se procesa el toggle

  // ── Utilidades locales ──────────────────────────────────────────────────
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
      'font-size:0.82rem;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,0.2);max-width:320px;';
    el.textContent = msg;
    cont.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2600);
    setTimeout(function () { el.remove(); }, 3000);
  }
  function manejarError(e) {
    if (e && e.tipo === 'auth') { clearSession(); location.href = 'index.html'; return; }
    toast((e && e.message) ? e.message : 'Ocurrió un error', 'error');
  }
  function fmtNum(n, dec) {
    if (n == null || n === '') return '—';
    var v = Number(n);
    if (isNaN(v)) return '—';
    return v.toLocaleString('es-CO', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
  }
  function fmtMoney(n) {
    if (n == null || n === '' || isNaN(Number(n))) return '—';
    return '$' + Number(n).toLocaleString('es-CO', { maximumFractionDigits: 0 });
  }
  var _MESES_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  function fechaES(iso) {
    if (!iso) return '';
    var p = String(iso).substring(0, 10).split('-');
    if (p.length < 3) return '';
    var mes = _MESES_ES[parseInt(p[1]) - 1] || p[1];
    return parseInt(p[2]) + ' ' + mes + ' ' + p[0];
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function renderStats(stats) {
    document.getElementById('sumTotal').textContent     = stats ? fmtNum(stats.total) : '—';
    document.getElementById('sumAprobadas').textContent = stats ? fmtNum(stats.aprobadas) : '—';
    document.getElementById('sumMl').textContent        = stats ? (fmtNum(stats.mlAprobado, 1) + ' m') : '—';
    document.getElementById('sumValor').textContent     = stats ? fmtMoney(stats.valorAprobado) : '—';
  }

  function chip(clase, label, val) {
    if (val == null || val === '' || Number(val) === 0) return '';
    return '<span class="cot-chip ' + clase + '">' + label + ' ' + fmtNum(val, 1) + 'm</span>';
  }

  function renderLista(list) {
    var body = document.getElementById('bodyCotiz');
    if (!list || !list.length) {
      body.innerHTML = '<div style="text-align:center;padding:56px 24px;grid-column:1/-1;color:var(--cf-gray-text);">' +
        'No hay cotizaciones con los filtros seleccionados.</div>';
      return;
    }
    var html = list.map(function (c) {
      var clase = c.aprobada ? 'aprobada' : (c.error ? 'con-error' : '');
      var cons = esc(c.consecutivo) + (c.version ? '.' + esc(c.version) : '');
      var capas = chip('c075', '0.75', c.mts075) + chip('c095', '0.95', c.mts095) +
                  chip('c115', '1.15', c.mts115) + chip('c140', 'C140', c.mtsC140);
      var errBadge = c.error ? '<span class="cot-error-badge">⚠ ' + esc(c.error) + '</span>' : '';
      var chequeo = (c.chequeo != null && Math.abs(Number(c.chequeo)) > 1)
        ? '<span class="cot-chequeo">Δ calibre vs ML: ' + fmtNum(c.chequeo, 1) + '</span>' : '';

      var cant = c.cantidad || 1;
      var accion;
      if (esAdmin) {
        if (c.aprobada) {
          accion = '<div style="display:flex;flex-direction:column;gap:5px;align-items:flex-end;">' +
            '<button class="btn-aprobar on" data-archivo="' + esc(c.archivo) + '">✓ Aprobada</button>' +
            '<label style="font-size:0.68rem;color:var(--cf-gray-text);display:flex;align-items:center;gap:5px;">Unidades' +
              '<input type="number" min="1" step="1" value="' + cant + '" data-cant="' + esc(c.archivo) + '" ' +
              'style="width:52px;padding:3px 6px;border:1.5px solid var(--cf-gray-mid);border-radius:6px;font-size:0.78rem;text-align:center;font-weight:700;"></label>' +
          '</div>';
        } else {
          accion = '<button class="btn-aprobar" data-archivo="' + esc(c.archivo) + '">Aprobar</button>';
        }
      } else {
        accion = c.aprobada ? '<span class="estado-aprob">✓ Aprobada' + (cant > 1 ? ' ×' + cant : '') + '</span>' : '';
      }

      // ML: por unidad; si hay varias unidades, mostrar el ×N y el total
      var mlLine;
      if (!c.mlTotal) {
        mlLine = 'sin ML';
      } else if (c.aprobada && cant > 1) {
        mlLine = fmtNum(c.mlTotal, 1) + ' ML ×' + cant + ' = <strong>' + fmtNum(c.mlTotal * cant, 1) + '</strong>';
      } else {
        mlLine = fmtNum(c.mlTotal, 1) + ' ML';
      }

      var linkBadge = c.vinculadas ? ' <span class="cot-link-badge">🔗 ' + c.vinculadas + '</span>' : '';
      return '<div class="cot-card ' + clase + '" data-detalle="' + esc(c.archivo) + '" style="cursor:pointer;">' +
        '<div class="cot-top"><div class="cot-proyecto">' + esc(c.proyecto || '(sin nombre)') + '</div>' +
          '<div class="cot-cons">CB' + cons + linkBadge + '</div></div>' +
        '<div class="cot-meta">Cliente ' + esc(c.codCliente || '—') +
          (c.fecha ? ' · ' + esc(fechaES(c.fecha)) : '') + '</div>' +
        (capas ? '<div class="cot-capas">' + capas + '</div>' : '') +
        (errBadge || chequeo ? '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' + errBadge + chequeo + '</div>' : '') +
        '<div class="cot-bottom">' +
          '<div><div class="cot-total">' + fmtMoney(c.subtotal) + (c.aprobada && cant > 1 ? ' <span style="font-size:0.7rem;color:var(--cf-gray-text);font-weight:600;">c/unidad</span>' : '') + '</div>' +
            '<div class="cot-ml">' + mlLine + '</div></div>' +
          accion +
        '</div></div>';
    }).join('');
    body.innerHTML = html;

    // Click en la card → detalle (excepto sobre los controles de acción)
    body.querySelectorAll('.cot-card').forEach(function (card) {
      card.addEventListener('click', function (e) {
        if (e.target.closest('.btn-aprobar, input, label')) return;
        abrirDetalle(card.getAttribute('data-detalle'));
      });
    });

    if (esAdmin) {
      body.querySelectorAll('.btn-aprobar').forEach(function (btn) {
        btn.addEventListener('click', function () { toggleAprobada(btn.getAttribute('data-archivo'), btn); });
      });
      body.querySelectorAll('input[data-cant]').forEach(function (inp) {
        inp.addEventListener('change', function () { cambiarCantidad(inp.getAttribute('data-cant'), inp); });
        // evitar que Enter recargue/propague raro
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') inp.blur(); });
      });
    }
  }

  // ── Acciones ────────────────────────────────────────────────────────────
  function cargar() {
    var body = document.getElementById('bodyCotiz');
    body.innerHTML = '<div style="text-align:center;padding:56px 24px;grid-column:1/-1;color:var(--cf-gray-text);">' +
      '<span class="spinner" style="border-color:rgba(0,0,0,0.1);border-top-color:var(--cf-blue);"></span></div>';
    var filtros = {
      anio:   document.getElementById('filtroAnio').value,
      mes:    document.getElementById('filtroMes').value,
      buscar: document.getElementById('filtroBuscar').value.trim(),
      soloAprobadas: document.getElementById('filtroAprobadas').value === 'si',
    };
    apiCotizList(token, filtros).then(function (resp) {
      _cache = resp.cotizaciones || [];
      poblarAnios(resp.anios || []);
      renderStats(resp.stats);
      renderLista(_cache);
    }).catch(manejarError);
  }

  // Puebla el <select> de años con los presentes en el maestro, preservando la selección.
  var _aniosPoblados = false;
  function poblarAnios(anios) {
    if (_aniosPoblados || !anios.length) return;
    var sel = document.getElementById('filtroAnio');
    var actual = sel.value;
    sel.innerHTML = '<option value="">Todos</option>' +
      anios.map(function (a) { return '<option value="' + esc(a) + '">' + esc(a) + '</option>'; }).join('');
    sel.value = actual;
    _aniosPoblados = true;
  }

  function toggleAprobada(archivo, btn) {
    if (_marcando[archivo]) return;
    var cot = _cache.filter(function (c) { return c.archivo === archivo; })[0];
    if (!cot) return;
    var nuevo = !cot.aprobada;
    _marcando[archivo] = true;
    btn.disabled = true;

    // Optimista
    cot.aprobada = nuevo;
    btn.className = 'btn-aprobar ' + (nuevo ? 'on' : '');
    btn.textContent = nuevo ? '✓ Aprobada' : 'Aprobar';

    apiCotizMarcar(token, archivo, nuevo).then(function () {
      toast(nuevo ? 'Cotización aprobada' : 'Aprobación retirada', 'ok');
      cargar(); // refresca stats y orden
    }).catch(function (e) {
      // Revertir
      cot.aprobada = !nuevo;
      btn.className = 'btn-aprobar ' + (cot.aprobada ? 'on' : '');
      btn.textContent = cot.aprobada ? '✓ Aprobada' : 'Aprobar';
      manejarError(e);
    }).finally(function () {
      _marcando[archivo] = false;
      btn.disabled = false;
    });
  }

  function cambiarCantidad(archivo, inp) {
    var cot = _cache.filter(function (c) { return c.archivo === archivo; })[0];
    if (!cot) return;
    var n = Math.max(1, parseInt(inp.value) || 1);
    inp.value = n; // normaliza (por si escribieron 0 o vacío)
    if (n === (cot.cantidad || 1)) return; // sin cambio
    inp.disabled = true;
    apiCotizMarcar(token, archivo, true, n).then(function () {
      cot.cantidad = n;
      toast('Cantidad actualizada a ' + n + (n === 1 ? ' casa' : ' casas'), 'ok');
      cargar(); // refresca stats (ML/valor ×N) y la línea de la card
    }).catch(function (e) {
      inp.value = cot.cantidad || 1; // revertir
      manejarError(e);
    }).finally(function () {
      inp.disabled = false;
    });
  }

  // ── Detalle: comparativo cotizado vs planeado + vínculos ─────────────────
  var _detalleArchivo = null;
  var _proyectosCache = null;   // para búsqueda manual de carpetas

  function abrirDetalle(archivo) {
    if (!archivo) return;
    _detalleArchivo = archivo;
    document.getElementById('vistaLista').classList.add('hidden');
    document.getElementById('vistaDetalle').classList.remove('hidden');
    document.getElementById('detNombre').textContent = 'Cargando…';
    document.getElementById('detBody').innerHTML =
      '<div style="text-align:center;padding:40px;"><span class="spinner" style="border-color:rgba(0,0,0,0.1);border-top-color:var(--cf-blue);"></span></div>';
    window.scrollTo(0, 0);
    apiCotizDetalle(token, archivo).then(renderDetalle).catch(function (e) {
      manejarError(e); cerrarDetalle();
    });
  }

  function cerrarDetalle() {
    _detalleArchivo = null;
    document.getElementById('vistaDetalle').classList.add('hidden');
    document.getElementById('vistaLista').classList.remove('hidden');
    cargar(); // refresca contadores de vínculos
  }

  function filaCmp(label, cot, plan) {
    var dif = cot - plan;
    var cls = dif > 1 ? 'cmp-dif-pos' : 'cmp-dif-ok';
    var txt = Math.abs(dif) < 0.05 ? '—' : (dif > 0 ? fmtNum(dif, 1) : '+' + fmtNum(-dif, 1));
    return '<tr><td>' + esc(label) + '</td><td>' + fmtNum(cot, 1) + '</td><td>' + fmtNum(plan, 1) + '</td><td class="' + cls + '">' + txt + '</td></tr>';
  }

  function renderDetalle(resp) {
    var c = resp.cotizacion, q = resp.cotizadoPorCasa, plan = resp.planeado;
    var cant = c.cantidad || 1;

    document.getElementById('detNombre').innerHTML = esc(c.proyecto || '(sin nombre)') +
      ' <span style="font-weight:400;color:var(--cf-gray-text);font-size:0.85rem;">CB' + esc(c.consecutivo) +
      (c.version ? '.' + esc(c.version) : '') + ' · ' + cant + (cant > 1 ? ' casas' : ' casa') + '</span>';

    // Comparativo POR UNIDAD. La carpeta de producción contiene los archivos de
    // UNA unidad y esos mismos archivos se reutilizan para las demás unidades
    // iguales del proyecto. Por eso NO se multiplica por la cantidad: hacerlo
    // compararía N unidades cotizadas contra 1 unidad de archivos → diferencia falsa.
    var nCarpetas = (resp.vinculadas || []).length;
    var rows = '', totCot = 0, sumPlanShown = 0;
    ['0.75', '0.95', '1.15'].forEach(function (cal) {
      var cot = q.c90[cal] || 0;
      var pl  = plan.c90[cal] || 0;
      totCot += cot; sumPlanShown += pl;
      rows += filaCmp('C90-37 · ' + cal, cot, pl);
    });
    var c140cot = (q.c140['0.75'] || 0) + (q.c140['0.95'] || 0) + (q.c140['1.15'] || 0);
    if (c140cot === 0 && q.c140.total_old) c140cot = q.c140.total_old;
    var c140plan = plan.c140.total || 0;
    if (c140cot > 0 || c140plan > 0) {
      totCot += c140cot; sumPlanShown += c140plan;
      rows += filaCmp('C140-46', c140cot, c140plan);
    }
    var otros = Math.round((plan.total - sumPlanShown) * 100) / 100;
    if (otros > 0.05) rows += filaCmp('Otros / sin clasificar', 0, otros);

    // Alcance explícito + el total del proyecto cuando se reutilizan los archivos.
    var alcance;
    if (nCarpetas === 0) {
      alcance = '<span style="color:#92400E;">Sin carpetas vinculadas — se muestra lo cotizado por 1 unidad. Vincula una carpeta abajo para comparar.</span>';
    } else {
      alcance = 'Comparación <strong>por unidad</strong>' +
        (cant > 1
          ? ' — los archivos de la carpeta se reutilizan para las ' + cant + ' unidades del proyecto (total a producir: ' +
            fmtNum((plan.total || 0) * cant, 1) + ' ML).'
          : '.');
    }

    var comparativo =
      '<div class="card-sec"><h3>Cotizado vs Planeado (metros lineales)</h3>' +
      '<p style="font-size:0.75rem;font-weight:600;margin:0 0 10px;">' + alcance + '</p>' +
      '<div style="overflow-x:auto;"><table class="cmp-table">' +
      '<thead><tr><th>Perfil · calibre</th><th>Cotizado (1 unidad)</th><th>Planeado</th><th>Diferencia</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '<tfoot>' + filaCmp('TOTAL', totCot, plan.total || 0) + '</tfoot>' +
      '</table></div>' +
      '<p style="font-size:0.7rem;color:var(--cf-gray-text);margin:10px 0 0;">"Planeado" = suma de EP2 exportados en las carpetas vinculadas (lo que se enviará a producir, aún no lo fabricado). "Diferencia" = cotizado − planeado; en verde cuando el plan cubre lo cotizado. El avance real de fabricación llegará con el checklist de paneles.</p>' +
      '</div>';

    // Vinculadas
    var vinc = (resp.vinculadas || []).map(function (f) {
      return '<div class="fld-row"><div class="fld-info"><div class="fld-nombre">' + esc(f.nombre) + '</div>' +
        '<div class="fld-meta">' + fechaES(f.fecha) + ' · ' + fmtNum(f.metrosTotal, 1) + ' ML · ' + esc(f.estado) + '</div></div>' +
        '<button class="fld-btn unlink" data-unlink="' + esc(f.carpetaId) + '">Quitar</button></div>';
    }).join('');
    var vincSec = '<div class="card-sec"><h3>Carpetas vinculadas (' + (resp.vinculadas || []).length + ')</h3>' +
      (vinc || '<div style="font-size:0.8rem;color:var(--cf-gray-text);">Aún no hay carpetas de producción vinculadas.</div>') + '</div>';

    // Sugerencias por CB
    var sugSec = '';
    if ((resp.sugerencias || []).length) {
      var sug = resp.sugerencias.map(function (f) {
        return '<div class="fld-row"><div class="fld-info"><div class="fld-nombre">' + esc(f.nombre) + '</div>' +
          '<div class="fld-meta">' + fechaES(f.fecha) + ' · ' + fmtNum(f.metrosTotal, 1) + ' ML</div></div>' +
          '<button class="fld-btn link" data-link="' + esc(f.carpetaId) + '">Vincular</button></div>';
      }).join('');
      sugSec = '<div class="card-sec"><h3>Sugerencias (código CB' + esc(c.consecutivo) + ')</h3>' + sug + '</div>';
    }

    // Búsqueda manual
    var manualSec = '<div class="card-sec"><h3>Vincular otra carpeta</h3>' +
      '<input id="detBuscarCarpeta" type="text" placeholder="Buscar carpeta por nombre…" style="width:100%;margin-bottom:8px;">' +
      '<div id="detResultados"></div></div>';

    document.getElementById('detBody').innerHTML = comparativo + vincSec + sugSec + manualSec;
    bindDetalle();
  }

  function bindDetalle() {
    var body = document.getElementById('detBody');
    body.querySelectorAll('[data-link]').forEach(function (b) {
      b.addEventListener('click', function () { vincular(b.getAttribute('data-link'), 'link', b); });
    });
    body.querySelectorAll('[data-unlink]').forEach(function (b) {
      b.addEventListener('click', function () { vincular(b.getAttribute('data-unlink'), 'unlink', b); });
    });
    var buscar = document.getElementById('detBuscarCarpeta');
    if (buscar) buscar.addEventListener('input', function () { buscarCarpetas(buscar.value); });
  }

  function vincular(carpetaId, accion, btn) {
    btn.disabled = true;
    apiCotizVincular(token, _detalleArchivo, carpetaId, accion).then(function () {
      toast(accion === 'link' ? 'Carpeta vinculada' : 'Carpeta quitada', 'ok');
      abrirDetalle(_detalleArchivo); // recarga el detalle (comparativo + listas)
    }).catch(function (e) { btn.disabled = false; manejarError(e); });
  }

  function buscarCarpetas(q) {
    var cont = document.getElementById('detResultados');
    q = String(q || '').trim().toLowerCase();
    if (q.length < 2) { cont.innerHTML = '<div style="font-size:0.75rem;color:var(--cf-gray-text);">Escribe al menos 2 letras…</div>'; return; }
    var pintar = function (lista) {
      var res = lista.filter(function (p) { return String(p.nombre || '').toLowerCase().indexOf(q) > -1; }).slice(0, 12);
      if (!res.length) { cont.innerHTML = '<div style="font-size:0.75rem;color:var(--cf-gray-text);">Sin coincidencias.</div>'; return; }
      cont.innerHTML = res.map(function (p) {
        return '<div class="fld-row"><div class="fld-info"><div class="fld-nombre">' + esc(p.nombre) + '</div>' +
          '<div class="fld-meta">' + fechaES(p.fecha) + ' · ' + fmtNum(p.metrosTotal, 1) + ' ML</div></div>' +
          '<button class="fld-btn link" data-link="' + esc(p.carpetaId) + '">Vincular</button></div>';
      }).join('');
      cont.querySelectorAll('[data-link]').forEach(function (b) {
        b.addEventListener('click', function () { vincular(b.getAttribute('data-link'), 'link', b); });
      });
    };
    if (_proyectosCache) { pintar(_proyectosCache); return; }
    cont.innerHTML = '<div style="font-size:0.75rem;color:var(--cf-gray-text);">Cargando carpetas…</div>';
    apiProdProyectosList(token, {}).then(function (r) {
      _proyectosCache = r.proyectos || [];
      pintar(_proyectosCache);
    }).catch(manejarError);
  }

  // ── Init ────────────────────────────────────────────────────────────────
  function init() {
    if (esAdmin) document.getElementById('modNav').classList.remove('hidden');
    document.getElementById('logoutBtn').addEventListener('click', function () {
      clearSession(); location.href = 'index.html';
    });
    document.getElementById('btnVolverCotiz').addEventListener('click', cerrarDetalle);
    document.getElementById('btnBuscar').addEventListener('click', cargar);
    document.getElementById('filtroAnio').addEventListener('change', cargar);
    document.getElementById('filtroMes').addEventListener('change', cargar);
    document.getElementById('filtroAprobadas').addEventListener('change', cargar);
    document.getElementById('filtroBuscar').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') cargar();
    });
    cargar();
    // Deep-link ?archivo=... → abre directo el detalle (usado por el panel de
    // "Atención" en Programación para saltar a vincular una carpeta).
    var archivoQS = new URLSearchParams(location.search).get('archivo');
    if (archivoQS) abrirDetalle(archivoQS);
  }

  init();
})();
