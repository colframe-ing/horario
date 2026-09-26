// ============================================================
// COTIZACIONES — vista del maestro + marcar aprobadas
// ============================================================
(function () {
  'use strict';

  var session = getSession();
  if (!session || !session.token) { location.href = 'index.html'; return; }
  // Módulo solo-admin: las cotizaciones muestran precios y utilidad.
  if (!puedeOperar(session)) { location.href = 'produccion.html'; return; }
  var token   = session.token;
  // Aprobar y cambiar las unidades es de Dirección; el administrativo ve el
  // estado ("✓ Aprobada") sin el botón (decisión del usuario, 25-sep).
  var esAdmin = esDireccion(session);

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
  // Etiqueta del estado derivado. Los nombres se leen desde la operación, no
  // desde el modelo: 'Producida' y no 'FINALIZADA'.
  var ESTADO_COTIZ = {
    SIN_APROBAR:   null,                                    // no se rotula: la card ya dice si está aprobada
    SIN_COLA:      { txt: 'Sin programar', bg: '#F1F5F9', fg: '#475569' },
    EN_COLA:       { txt: 'En cola',       bg: '#DBEAFE', fg: '#1D4ED8' },
    EN_PRODUCCION: { txt: 'En producción', bg: '#CFFAFE', fg: '#0E7490' },
    PAUSADA:       { txt: 'Pausada',       bg: '#FEF3C7', fg: '#92400E' },
    PARCIAL:       { txt: 'Parcial',       bg: '#EDE9FE', fg: '#6D28D9' },
    PRODUCIDA:     { txt: 'Producida',     bg: '#D1FAE5', fg: '#065F46' },
  };
  function estadoCotizHtml(c) {
    var d = ESTADO_COTIZ[c.estadoCotiz];
    if (!d) return '';
    var det = '';
    // En PARCIAL el dato útil es cuántas unidades faltan, no el rótulo solo.
    if (c.estadoCotiz === 'PARCIAL' && c.conteos) {
      det = ' ' + c.conteos.finalizadas + '/' + c.conteos.total;
    }
    return ' <span class="cot-estado" style="background:' + d.bg + ';color:' + d.fg + ';">' +
           esc(d.txt + det) + '</span>';
  }

  function renderStats(stats) {
    document.getElementById('sumTotal').textContent     = stats ? fmtNum(stats.total) : '—';
    document.getElementById('sumAprobadas').textContent = stats ? fmtNum(stats.aprobadas) : '—';
    document.getElementById('sumMl').textContent        = stats ? (fmtNum(stats.mlAprobado, 1) + ' m') : '—';
    document.getElementById('sumValor').textContent     = stats ? fmtMoney(stats.valorAprobado) : '—';
    // Cortes por estado. "En avance" es lo declarado al pausar, no un hecho
    // medido: va aparte de lo producido a propósito (PLAN_ESTADOS §4).
    var cortes = [
      ['Producido', 'sumMlProducido', 'sumValorProducido', 'mlProducido', 'valorProducido'],
      ['Avance',    'sumMlAvance',    'sumValorAvance',    'mlAvance',    'valorAvance'],
      ['Pendiente', 'sumMlPendiente', 'sumValorPendiente', 'mlPendiente', 'valorPendiente'],
    ];
    cortes.forEach(function (c) {
      var elMl = document.getElementById(c[1]), elVal = document.getElementById(c[2]);
      if (!elMl || !elVal) return;
      elMl.textContent  = stats ? (fmtNum(stats[c[3]], 1) + ' m') : '—';
      elVal.textContent = stats ? fmtMoney(stats[c[4]]) : '—';
    });
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
      // Estado DERIVADO de las unidades de la cola. Antes esta página recibía
      // `estado` y no lo mostraba, y de todos modos ese venía vacío para los
      // proyectos partidos en envíos: el estado real vive en cada envío.
      // PARCIAL es el que no se podía ver en ninguna pantalla.
      var estadoBadge = estadoCotizHtml(c);
      return '<div class="cot-card ' + clase + '" data-detalle="' + esc(c.archivo) + '" style="cursor:pointer;">' +
        '<div class="cot-top"><div class="cot-proyecto">' + esc(c.proyecto || '(sin nombre)') + estadoBadge + '</div>' +
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
        abrirProyecto(card.getAttribute('data-detalle'));
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
    var actual = sel.value || _anioGuardado;
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

  // ── Abrir un proyecto ───────────────────────────────────────────────────
  //
  // Hasta el 22-sep la tarjeta abría aquí mismo un "detalle" —cotizado vs
  // planeado, producción y despacho, carpetas— y ese detalle tenía un botón
  // para ir a la hoja de vida, que mostraba buena parte de lo mismo de otra
  // forma. Ahora son una sola pantalla: el detalle vive en `proyecto.html`,
  // dentro del bloque de cada cotización, y la tarjeta lleva ahí con ESA
  // cotización primera y abierta.
  function urlProyecto(cb, archivo) {
    return 'proyecto.html?cb=' + encodeURIComponent(cb) +
           (archivo ? '&archivo=' + encodeURIComponent(archivo) : '');
  }

  function abrirProyecto(archivo) {
    var c = _cache.filter(function (x) { return x.archivo === archivo; })[0];
    if (!c || !c.consecutivo) { toast('Esta cotización no tiene consecutivo CB', 'error'); return; }
    guardarFiltros();
    location.href = urlProyecto(c.consecutivo, archivo);
  }

  // Los filtros sobreviven a la ida y vuelta. Antes el detalle se abría en la
  // misma página y la lista seguía debajo; ahora se sale a otra, y volver sin
  // esto dejaba a quien buscaba otra vez en "Todos". Por pestaña, y nunca
  // necesario: sin almacenamiento la lista arranca como siempre.
  var CLAVE_FILTROS = 'cf_cotiz_filtros';
  var _anioGuardado = '';
  function guardarFiltros() {
    try {
      sessionStorage.setItem(CLAVE_FILTROS, JSON.stringify({
        anio: document.getElementById('filtroAnio').value,
        mes: document.getElementById('filtroMes').value,
        buscar: document.getElementById('filtroBuscar').value,
        aprobadas: document.getElementById('filtroAprobadas').value,
      }));
    } catch (e) { /* sin almacenamiento: no pasa nada */ }
  }
  function restaurarFiltros() {
    var f = null;
    try { f = JSON.parse(sessionStorage.getItem(CLAVE_FILTROS) || 'null'); } catch (e) { f = null; }
    if (!f) return;
    // El año se aplica cuando llegan las opciones (`poblarAnios`): antes de eso
    // el <select> no tiene ese valor y lo descartaría en silencio.
    _anioGuardado = f.anio || '';
    document.getElementById('filtroMes').value = f.mes || '';
    document.getElementById('filtroBuscar').value = f.buscar || '';
    if (f.aprobadas) document.getElementById('filtroAprobadas').value = f.aprobadas;
  }

  // ── Init ────────────────────────────────────────────────────────────────
  function init() {
    document.getElementById('modNav').classList.remove('hidden');   // quien llega aquí ya puede operar
    document.getElementById('logoutBtn').addEventListener('click', function () {
      clearSession(); location.href = 'index.html';
    });
    document.getElementById('btnBuscar').addEventListener('click', cargar);
    document.getElementById('filtroAnio').addEventListener('change', cargar);
    document.getElementById('filtroMes').addEventListener('change', cargar);
    document.getElementById('filtroAprobadas').addEventListener('change', cargar);
    document.getElementById('filtroBuscar').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') cargar();
    });
    // `?archivo=…` era el enlace directo al detalle, y lo siguen usando dos
    // botones de Programación y cualquier enlace guardado. El detalle ya no
    // vive aquí, así que se averigua el CB y se sigue a la hoja de vida. Con
    // `replace`, para que "atrás" no vuelva a caer en este rebote.
    var archivoQS = new URLSearchParams(location.search).get('archivo');
    if (archivoQS) {
      apiCotizDetalle(token, archivoQS).then(function (r) {
        var cb = r && r.cotizacion && r.cotizacion.consecutivo;
        if (!cb) throw new Error('Esa cotización no tiene consecutivo CB');
        location.replace(urlProyecto(cb, archivoQS));
      }).catch(function (e) { manejarError(e); cargar(); });
      return;
    }
    restaurarFiltros();
    cargar();
  }

  init();
})();
