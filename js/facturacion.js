// ============================================================
// FACTURACIÓN — tres vistas con trabajos distintos
// ============================================================
//
// La pantalla anterior tenía CUATRO tablas del mismo peso visual, y estaban
// intercaladas entre los dos ejes de la facturación:
//
//   Salió y nadie lo facturó   ← eje remisión
//   Aprobado contra facturado  ← eje cotización
//   Facturadas recientemente   ← eje remisión
//   Facturas por repartir      ← eje cotización
//
// Saltaban de un eje al otro y volvían, y ninguna se llamaba "facturas", que es
// de donde parte quien trabaja. Para procesar UNA factura había que tocar tres
// sitios distintos y en ninguno se veía cómo iba esa factura completa.
//
// Ahora son tres vistas con propósitos que no se parecen:
//
//   POR COBRAR    la alerta. Es la única que cuesta plata: material que salió y
//                 nadie cobró. Unidad: la remisión.
//   FACTURAS      el trabajo. Una fila por factura con sus DOS pendientes, y un
//                 panel que hace las dos mitades sin salir. Unidad: la factura.
//   POR PROYECTO  el reporte. Se mira, no se opera. Unidad: la cotización.
//
// Lo que NO cambió: ninguna regla de plata. El monto sigue yendo sin AIU con el
// AIU aparte, no se prorratea nada por kg, y anular sigue pidiendo motivo. Son
// las reglas que evitan un descuadre medido, no fricción sobrante.
(function () {
  'use strict';

  var session = getSession();
  if (!session || !session.token) { location.href = 'index.html'; return; }
  // Solo admin: esta pantalla muestra precios, márgenes y cobros.
  if (!session.esAdmin) { location.href = 'produccion.html'; return; }
  var token = session.token;

  var _datos = null;
  var _backendViejo = false;  // respondió un Apps Script anterior a esta pantalla
  var vista = 'facturas';     // cobrar | facturas | proyecto
  var abierta = null;         // número de la factura desplegada
  var sugAbierta = null;      // sugerencias de esa factura (llegan aparte)
  var filtro = 'todas';
  var busca = '';
  var marcadas = {};          // docId → true, en la vista Por cobrar

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
  // RM-0250, FE322, CB581.1: todos mezclan letras con números, y una comparación
  // de cadenas los ordena mal en cuanto los dígitos no están rellenados con
  // ceros. `FE1000` va ANTES que `FE322` alfabéticamente, porque compara el '1'
  // contra el '3'. Los consecutivos de remisión sí vienen con ceros, pero
  // depender de eso obliga a recordar cuál de los tres formatos los tiene.
  function _trozos(s) {
    return String(s == null ? '' : s).toUpperCase().match(/\d+|\D+/g) || [];
  }
  function cmpRef(a, b) {
    var ta = _trozos(a), tb = _trozos(b);
    var n = Math.max(ta.length, tb.length);
    for (var i = 0; i < n; i++) {
      var x = ta[i], y = tb[i];
      if (x === undefined) return -1;          // el más corto primero: FE32 < FE322
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
  function porRef(campo) {
    return function (a, b) {
      var va = String(a[campo] == null ? '' : a[campo]).trim();
      var vb = String(b[campo] == null ? '' : b[campo]).trim();
      // Las filas SIN identificador van PRIMERO, no al final: una remisión firme
      // sin consecutivo existe y es en sí misma algo que hay que mirar.
      if (!va && !vb) return 0;
      if (!va) return -1;
      if (!vb) return 1;
      return cmpRef(va, vb);
    };
  }

  // ── Estado de carga ──────────────────────────────────────────────────────
  //
  // DOS MODOS, y la diferencia es de dónde viene la llamada. La primera carga no
  // tiene nada que mostrar, así que el spinner es correcto. Un refresco DESPUÉS
  // de escribir sí tiene: la tabla que estás mirando. `factura_tablero` hace
  // ocho barridos de hoja en tres spreadsheets, así que borrarla convertía cada
  // asignación en un parpadeo de la pantalla entera.
  function estado(clase, html) {
    var el = document.getElementById('estadoCarga');
    if (!el) return;
    if (!clase) { el.className = 'fact-estado hidden'; el.innerHTML = ''; return; }
    el.className = 'fact-estado ' + clase;
    el.innerHTML = html;
  }

  function cargar(silencioso) {
    if (silencioso) estado('trabajando', '<span class="spinner"></span> Actualizando los números…');
    else document.getElementById('vista').innerHTML =
      '<div class="fact-cargando"><span class="spinner"></span></div>';

    return apiFacturaTablero(token).then(function (r) {
      _datos = r;
      // ¿El backend que respondió es el que esta pantalla necesita?
      //
      // Hace falta distinguirlo porque los dos casos se veían IGUAL y el mensaje
      // que salía era el equivocado: sin `facturas` la lista queda vacía, y de
      // ahí se concluía "el maestro de facturas está vacío, corre el sync" —
      // mandando a arreglar un Sheet que estaba perfecto.
      //
      // `facturas` AUSENTE (undefined) es un backend viejo. `facturas` presente
      // y vacío es un maestro de verdad vacío. Son cosas distintas y ahora se
      // dicen distinto.
      _backendViejo = (r && r.facturas === undefined);
      estado(null);
      pintar();
    }).catch(function (e) {
      var msg = (e && e.message) ? e.message : 'No se pudo cargar';
      if (silencioso && _datos) {
        // NO se borra lo que hay: la escritura sí funcionó, lo que falló fue
        // volver a leer. Pero lo que quedó en pantalla es de ANTES de esa
        // escritura, o sea que está mal y tiene cara de estar bien.
        estado('viejo', '⚠ Se guardó, pero no se pudieron releer los números: ' + esc(msg) +
                        ' — lo que ves es de antes de ese cambio.');
      } else {
        estado(null);
        document.getElementById('vista').innerHTML = '<div class="vacio">' + esc(msg) + '</div>';
      }
      manejarError(e);
    });
  }

  // ══ VISTA 1 · POR COBRAR ═════════════════════════════════════════════════
  //
  // La única que cuesta plata. Se agrupa POR PROYECTO porque la acción casi
  // siempre es "esta factura cubre estas tres remisiones del mismo proyecto", y
  // los grupos van por su remisión más vieja: así lo urgente flota sin perder el
  // orden por consecutivo dentro de cada uno, que es como se busca teniendo el
  // papel en la mano.
  // A-01 · PLATA SIN COBRAR Y PAPELEO PENDIENTE NO SON LO MISMO.
  //
  // Cada fila trae un `motivo` del backend: `SIN_COBRAR` (la cotización tiene
  // saldo) o `SOLO_REGISTRO` (ya está cobrada —o hubo anticipo— y lo único que
  // falta es escribirle el número a esta remisión).
  //
  // Un backend anterior no manda `motivo`, y entonces todo cuenta como
  // `SIN_COBRAR`: es el comportamiento de siempre, y es el lado seguro.
  // Degradar por omisión escondería plata.
  function soloRegistro(r) { return r && r.motivo === 'SOLO_REGISTRO'; }

  function vistaCobrar() {
    var lista = (_datos.sinFacturar || []);
    if (!lista.length) {
      return '<div class="vacio">Nada pendiente: todo lo que salió está facturado.</div>';
    }

    var porProy = {};
    lista.forEach(function (r) {
      var k = r.cotizacionArchivo || '(sin proyecto)';
      (porProy[k] = porProy[k] || { archivo: r.cotizacionArchivo, proyecto: r.proyecto,
                                    cb: r.cb, version: r.version, rs: [] }).rs.push(r);
    });
    var grupos = Object.keys(porProy).map(function (k) {
      var g = porProy[k];
      g.rs.sort(porRef('consecutivo'));
      // `dias` puede ser null cuando la fila no tiene fecha: cuenta como 0 para
      // no mandar el grupo entero al tope por un dato faltante.
      g.maxDias = g.rs.reduce(function (m, x) { return Math.max(m, x.dias || 0); }, 0);
      // El grupo es HOMOGÉNEO: el motivo se deriva del saldo de la cotización, y
      // el grupo es justamente una cotización. Así que basta mirar la primera.
      g.soloRegistro = soloRegistro(g.rs[0]);
      // Estado de la casilla del grupo. Solo cuentan las que se pueden marcar:
      // una fila sin `docId` lleva la casilla deshabilitada, y exigirla para
      // decir "todas" dejaría el grupo eternamente a medias.
      var marcables = g.rs.filter(function (x) { return !!x.docId; });
      var n = marcables.filter(function (x) { return marcadas[x.docId]; }).length;
      g.todas   = marcables.length > 0 && n === marcables.length;
      g.algunas = n > 0;
      return g;
    }).sort(function (a, b) {
      // La plata primero, y dentro de cada bloque lo más viejo arriba. El
      // papeleo se hace cuando se pueda; la deuda no espera a que baje.
      if (a.soloRegistro !== b.soloRegistro) return a.soloRegistro ? 1 : -1;
      return b.maxDias - a.maxDias;
    });

    // Los cortes cuentan SOLO la plata. Antes el primero decía `lista.length`,
    // que sumaba papeleo: "12 sin cobrar" cuando nueve ya estaban cobradas.
    // El de 30 días también se filtra — envejecer un trámite no es una deuda.
    var plata  = lista.filter(function (r) { return !soloRegistro(r); });
    var tramit = lista.filter(soloRegistro);
    var viejas = plata.filter(function (r) { return (r.dias || 0) >= 30; }).length;
    var proyPlata = {};
    plata.forEach(function (r) { proyPlata[r.cotizacionArchivo || ''] = true; });

    var h = '<div class="fact-cortes">' +
      corte('d', 'Sin cobrar', plata.length,
            plata.length === 1 ? 'remisión despachada' : 'remisiones despachadas') +
      corte('c', 'Más de 30 días', viejas, viejas === 1 ? 'remisión' : 'remisiones') +
      corte('a', 'Proyectos', Object.keys(proyPlata).length, 'con algo sin cobrar') +
      (tramit.length
        ? corte('b', 'Solo registro', tramit.length,
                tramit.length === 1 ? 'ya cobrada, falta el número' : 'ya cobradas, falta el número')
        : '') +
      '</div>';

    if (plata.length === 0 && tramit.length) {
      h += '<div class="aviso info">Nada por cobrar. Las ' + tramit.length + ' de abajo ' +
        'ya están cobradas en su cotización: lo único que falta es anotarles el número ' +
        'de factura.</div>';
    }

    h += grupos.map(function (g) {
      // `urgente` solo si es plata: un trámite de 90 días no es una deuda de 90
      // días, y pintarlo igual es lo que enseña a ignorar el color.
      var urge = !g.soloRegistro && g.maxDias >= 30;
      return '<div class="grupo' + (urge ? ' urgente' : '') +
             (g.soloRegistro ? ' tramite' : '') + '">' +
        '<div class="grupo-top">' +
          // EL CHECKBOX DEL GRUPO SOLO CUANDO HAY MÁS DE UNA.
          //
          // Con una sola remisión hacía exactamente lo mismo que el de la fila,
          // así que eran dos casillas para una decisión. Y como nunca se
          // dibujaba marcada, al oprimirla se marcaba la de abajo y ella se
          // quedaba en blanco: parecía que no había funcionado. Reportado.
          //
          // Cuando sí hay varias tiene sentido —es "marcar todas"— y ahora
          // refleja el estado: marcada si lo están todas, a medias si algunas.
          // `indeterminate` no se puede poner por atributo, así que va en
          // `data-medias` y lo aplica `pintar()` después de escribir el HTML.
          (g.rs.length > 1
            ? '<input type="checkbox" data-grupo="' + esc(g.archivo) + '"' +
                (g.todas ? ' checked' : '') + (g.algunas && !g.todas ? ' data-medias="1"' : '') +
                ' aria-label="Marcar todas las de ' + esc(g.proyecto || g.archivo) + '">'
            : '<span class="sin-casilla" aria-hidden="true"></span>') +
          '<span class="gn">' + esc(g.proyecto || g.archivo || '(sin proyecto)') + '</span>' +
          // El código de la cotización: es lo que está escrito en el papel, y dos
          // obras pueden llamarse igual.
          (g.cb ? '<span class="gcb-ref">CB' + esc(g.cb) +
                  (g.version ? '.' + esc(g.version) : '') + '</span>' : '') +
          (g.soloRegistro
            ? '<span class="etq-tramite" title="La cotización ya está cobrada por completo. ' +
              'Falta anotarle el número de factura a estas remisiones.">solo registro</span>'
            : '') +
          '<span class="espacio"></span>' +
          '<span class="gcb">' + g.rs.length + (g.rs.length === 1 ? ' remisión' : ' remisiones') + '</span>' +
          '<span class="dias' + (urge ? ' viejo' : '') + '">hasta ' + g.maxDias + ' d</span>' +
        '</div>' +
        g.rs.map(function (r) {
          var dias = r.dias == null
            ? '<span class="dias">sin fecha</span>'
            : '<span class="dias' + (!g.soloRegistro && r.dias >= 30 ? ' viejo' : '') + '">' +
              r.dias + ' d</span>';
          return '<div class="rem-fila">' +
            '<input type="checkbox" data-rem="' + esc(r.docId) + '" data-arch="' + esc(r.cotizacionArchivo || '') + '"' +
              (marcadas[r.docId] ? ' checked' : '') + (r.docId ? '' : ' disabled') +
              ' aria-label="Marcar ' + esc(r.consecutivo || 'remisión sin consecutivo') + '">' +
            '<span class="rnum">' + esc(r.consecutivo || '(sin consecutivo)') + '</span>' +
            '<span class="gcb">' + esc(r.fecha || '—') + '</span>' +
            dias +
            '<span class="gcb">' + esc(r.estado || '') + '</span>' +
          '</div>';
        }).join('') +
      '</div>';
    }).join('');

    var sel = seleccionadas();
    if (sel.length) {
      var cands = candidatasPara(sel);
      h += '<div class="accion">' +
        '<span class="cuenta">' + sel.length + (sel.length === 1 ? ' marcada' : ' marcadas') + '</span>' +
        (cands.length
          ? '<span class="sugfact"><span class="et">sugeridas:</span>' +
            cands.slice(0, 4).map(function (c) {
              return '<button data-usarlote="' + esc(c.numero) + '" title="' + esc(c.detalle || '') + '">' +
                     esc(c.numero) + '</button>';
            }).join('') + '</span>'
          : '<span class="et">sin sugerencia — se escribe el número</span>') +
        '<span class="espacio"></span>' +
        '<button data-limpiar="1">Quitar marca</button>' +
        '<button class="primario" data-lote="1">Registrar factura</button>' +
      '</div>';
    }
    return h;
  }

  function seleccionadas() {
    return (_datos.sinFacturar || []).filter(function (r) { return marcadas[r.docId]; })
      .map(function (r) {
        return { docId: r.docId, rotulo: r.consecutivo || '(sin consecutivo)',
                 archivo: r.cotizacionArchivo || '' };
      });
  }

  /** Las facturas que el backend propone para los proyectos de estas remisiones.
   *  Una selección puede mezclar proyectos —es legítimo: una factura cubre varias
   *  remisiones y nada obliga a que sean del mismo CB— así que se unen las
   *  candidatas de todos, sin repetir. */
  function candidatasPara(docs) {
    var mapa = (_datos && _datos.candidatasPorCotizacion) || {};
    var vistas = {}, out = [];
    (docs || []).forEach(function (d) {
      (mapa[d.archivo] || []).forEach(function (c) {
        if (vistas[c.numero]) return;
        vistas[c.numero] = true;
        out.push(c);
      });
    });
    return out;
  }

  // ══ VISTA 2 · FACTURAS ═══════════════════════════════════════════════════

  // ── Lo que dice la fila ──────────────────────────────────────────────────
  //
  // La fila mostraba `fecha · DIAN {dianStatus}`. En las 148 facturas del
  // histórico ese campo dice `DIAN_ACEPTADO` en LAS 148: un campo con un solo
  // valor no informa nada, y estaba ocupando el renglón más caro de la
  // pantalla. En su lugar van el cliente y el proyecto, que son dos de las tres
  // formas en que alguien busca una factura (la tercera es el número, que ya
  // estaba).
  //
  // Las tres son FUNCIONES PURAS y están probadas en `facturacion_fila.test.js`
  // contra el archivo real.

  /** El estado DIAN normal. Todo lo demás se muestra. */
  var DIAN_NORMAL = 'DIAN_ACEPTADO';

  /** El estado DIAN, solo cuando dice algo, y ya listo para pintar.
   *
   *  La regla es "todo lo que NO sea el normal" y no una lista de valores
   *  malos: un estado que nadie previó tiene que saltar a la vista en vez de
   *  pasar de largo por no estar en la lista.
   *
   *  Y se le quita el prefijo `DIAN_` que el propio valor trae, porque la
   *  etiqueta de al lado ya dice DIAN: sin esto sale "DIAN DIAN_RECHAZADO",
   *  que es la misma tartamudez que tenía la fila antes de este cambio. */
  function dianAnormal(f) {
    var s = String((f && f.dianStatus) || '').trim();
    if (!s || s.toUpperCase() === DIAN_NORMAL) return '';
    return s.replace(/^DIAN[_ ]/i, '');
  }

  /** A quién se le cobró.
   *
   *  `razonSocial` viene VACÍA en 14 de las 148 del histórico, así que sin
   *  respaldo la fila quedaría peor que antes en el 9% de los casos. Cuando no
   *  hay ninguno de los dos se devuelve cadena vacía y no un guion: un guion se
   *  lee como "no tiene cliente", que es una afirmación, y lo que pasa es que
   *  no lo sabemos. */
  function clienteDe(f) {
    var rs = String((f && f.razonSocial) || '').trim();
    if (rs) return rs;
    var nit = String((f && f.nit) || '').trim();
    return nit ? 'NIT ' + nit : '';
  }

  /** Los proyectos de una factura, por orden de firmeza.
   *
   *    1. el reparto vivo  — un HECHO: alguien lo asignó
   *    2. las remisiones   — un HECHO: la factura salió amparando eso
   *    3. lo que dice la nota — una PROPUESTA, y sale rotulada
   *
   *  LOS NIVELES NO SE MEZCLAN. Si hay reparto, la nota no agrega nada a la
   *  fila; si hay remisiones, tampoco. Pintar juntos un hecho y una propuesta,
   *  sin rótulo, es exactamente cómo una propuesta termina leyéndose como un
   *  hecho — y acá el hecho es a quién se le cobró plata.
   *
   *  `ctx` es lo que la vista ya tiene en memoria: `porArchivo` (archivo →
   *  nombre del proyecto, de `_datos.cotizaciones`) y `candidatas`
   *  (`candidatasPorCotizacion`, que el tablero ya manda). Ninguna llamada
   *  nueva. */
  function proyectosDe(f, ctx) {
    var porArchivo = (ctx && ctx.porArchivo) || {};
    var candidatas = (ctx && ctx.candidatas) || {};
    var vistos = {}, nombres = [];
    var agregar = function (nombre) {
      var n = String(nombre || '').trim();
      if (!n || vistos[n]) return;
      vistos[n] = true;
      nombres.push(n);
    };

    // 1 — el reparto. `proyecto` puede venir vacío cuando la cotización no está
    // en la cola; el archivo sigue sirviendo para buscar el nombre.
    ((f && f.reparto) || []).forEach(function (a) {
      agregar(a.proyecto || porArchivo[a.cotizacionArchivo]);
    });
    if (nombres.length) return { nombres: nombres, propuesto: false };

    // 2 — las remisiones que ampara.
    ((f && f.remisiones) || []).forEach(function (r) {
      agregar(r.proyecto || porArchivo[r.cotizacionArchivo]);
    });
    if (nombres.length) return { nombres: nombres, propuesto: false };

    // 3 — lo que la nota menciona. Solo `NOTA`/`AMBAS`: una candidata por
    // `REMISION` dice "esta factura ya está en otra remisión de ese proyecto",
    // que es otra afirmación y se vería por el eje de remisiones si aplicara a
    // ESTA factura.
    Object.keys(candidatas).forEach(function (archivo) {
      (candidatas[archivo] || []).forEach(function (c) {
        if (c.numero !== (f && f.numero)) return;
        if (c.motivo !== 'NOTA' && c.motivo !== 'AMBAS') return;
        agregar(porArchivo[archivo]);
      });
    });
    return { nombres: nombres, propuesto: nombres.length > 0 };
  }

  /** El rótulo de la fila: el primero y cuántos más. */
  function rotuloProyectos(p) {
    var ns = (p && p.nombres) || [];
    if (!ns.length) return '';
    var txt = ns.length > 1 ? ns[0] + ' +' + (ns.length - 1) : ns[0];
    return p.propuesto ? 'propuesto: ' + txt : txt;
  }

  /** El índice archivo → nombre de proyecto, que `proyectosDe` necesita. */
  function indiceProyectos() {
    var out = {};
    ((_datos && _datos.cotizaciones) || []).forEach(function (c) {
      if (c.archivo) out[c.archivo] = c.proyecto || c.archivo;
    });
    return out;
  }

  function estadoFactura(f) {
    var rTot = (f.remisiones || []).length;
    return {
      rTot: rTot,
      repartoOk: Math.abs(f.sinAsignar) < 0.5,
      // Sin remisiones y sin poder saber si le faltan: no se puede afirmar que
      // esté completa por ese eje, pero tampoco que le falte. Lo decide quien
      // mira si hay remisiones pendientes que la sugieran.
      sugeridas: remisionesSugeridas(f).length,
    };
  }

  /** Remisiones pendientes que apuntan a esta factura.
   *
   *  Se deriva en el navegador de dos cosas que el tablero ya trae: las
   *  remisiones sin facturar y el índice de candidatas por cotización. Una
   *  remisión pendiente sugiere la factura N si N es candidata de SU proyecto. */
  function remisionesSugeridas(f) {
    var mapa = (_datos && _datos.candidatasPorCotizacion) || {};
    return (_datos.sinFacturar || []).filter(function (r) {
      if (!r.docId) return false;
      return (mapa[r.cotizacionArchivo] || []).some(function (c) { return c.numero === f.numero; });
    });
  }

  function vistaFacturas() {
    // El backend viejo no manda `facturas`, así que esta vista no puede
    // dibujarse. Se dice qué falta y cómo arreglarlo, en vez de mostrar una
    // lista vacía que se lee como "no hay facturas".
    if (_backendViejo) return avisoBackendViejo();
    var facturas = _datos.facturas || [];
    var sinRep = 0, nPend = 0;
    facturas.forEach(function (f) {
      if (f.sinAsignar > 0.5) sinRep += f.sinAsignar;
      var e = estadoFactura(f);
      if (!e.repartoOk || e.sugeridas) nPend++;
    });

    var h = '<div class="fact-cortes">' +
      corte('a', 'Facturas', facturas.length, 'en el maestro') +
      corte('c', 'Sin repartir', money(sinRep), 'de las que tienen saldo') +
      corte('b', 'Con algo pendiente', nPend, nPend === 1 ? 'factura' : 'facturas') +
      '</div>';

    h += '<div class="barra-f">' +
      '<input class="buscar" id="buscar" type="search" value="' + esc(busca) + '" ' +
        'placeholder="Buscar factura, cliente, proyecto o remisión…" aria-label="Buscar">' +
      [['todas', 'Todas'], ['pendiente', 'Algo pendiente'],
       ['reparto', 'Sin repartir'], ['remision', 'Con remisiones sueltas']]
        .map(function (x) {
          return '<button class="fchip" data-f="' + x[0] + '" aria-pressed="' +
                 (filtro === x[0]) + '">' + x[1] + '</button>';
        }).join('') +
      // No dice cuántas son hasta que se oprime, a propósito: saberlo obligaría
      // a correr la compuerta en cada carga de la pantalla, y la compuerta lee
      // seis hojas. Un clic muestra el plan; el segundo lo escribe.
      '<button class="btn-auto" data-auto="1">Asignar las seguras…</button>' +
      '</div>';

    var vis = facturas.filter(function (f) {
      var e = estadoFactura(f);
      if (filtro === 'reparto'  && e.repartoOk) return false;
      if (filtro === 'remision' && !e.sugeridas) return false;
      if (filtro === 'pendiente' && e.repartoOk && !e.sugeridas) return false;
      if (!busca) return true;
      var b = busca.toLowerCase();
      // El cliente entra a la búsqueda junto con el número y las notas: con 51
      // clientes distintos en el histórico, "las de INFRAESTRUCTURA" es una de
      // las tres formas naturales de llegar a una factura.
      return (f.numero + ' ' + (f.notas || '') + ' ' +
              (f.razonSocial || '') + ' ' + (f.nit || '')).toLowerCase().indexOf(b) !== -1 ||
        (f.remisiones || []).some(function (r) {
          return ((r.consecutivo || '') + ' ' + (r.proyecto || '')).toLowerCase().indexOf(b) !== -1; }) ||
        (f.reparto || []).some(function (r) {
          return ((r.cb || '') + ' ' + (r.proyecto || '')).toLowerCase().indexOf(b) !== -1; });
    // DE LA MÁS NUEVA A LA MÁS ANTIGUA: son las que están sin repartir y las que
    // alguien tiene en la mano. Las viejas ya se procesaron, y si una vieja
    // quedara pendiente sigue encontrándose por el buscador y por los filtros.
    }).sort(function (a, b) { return porRef('numero')(b, a); });

    if (!vis.length) {
      return h + '<div class="vacio">' +
        (facturas.length ? 'Ninguna factura coincide.'
          : 'El maestro de facturas está vacío. Corre <code>factImportarFacturas()</code> o el .bat de sync.') +
        '</div>';
    }

    var ctxProy = { porArchivo: indiceProyectos(),
                    candidatas: (_datos && _datos.candidatasPorCotizacion) || {} };

    h += '<div class="lista">' + vis.map(function (f) {
      var e = estadoFactura(f), ab = abierta === f.numero;
      // Eje 1 — remisiones.
      var ejeR;
      if (e.rTot === 0 && !e.sugeridas) {
        ejeR = '<span class="estado na">ninguna</span>';
      } else if (e.sugeridas) {
        var tot = e.rTot + e.sugeridas;
        ejeR = '<span class="barrita"><i style="width:' + Math.round(e.rTot / tot * 100) + '%"></i></span>' +
               '<span>' + e.rTot + '/' + tot + '</span>';
      } else {
        ejeR = '<span class="barrita full"><i style="width:100%"></i></span><span>' + e.rTot + '</span>';
      }
      // Eje 2 — plata.
      var ejeP = e.repartoOk ? '<span class="estado ok">repartida</span>'
        : (f.sinAsignar < 0 ? '<span class="estado bad">' + money(f.sinAsignar) + ' de más</span>'
          : '<span class="estado warn">' + money(f.sinAsignar) + '</span>');

      var cli = clienteDe(f), dian = dianAnormal(f);
      var proy = rotuloProyectos(proyectosDe(f, ctxProy));

      return '<button class="fila" data-num="' + esc(f.numero) + '" aria-expanded="' + ab + '">' +
          '<div><div class="num"><span class="n">' + esc(f.numero) + '</span>' +
            (cli ? '<span class="cli">' + esc(cli) + '</span>' : '') + '</div>' +
          '<div class="meta">' +
            esc(f.fecha || 'sin fecha') +
            (proy ? ' · ' + esc(proy) : '') +
            (dian ? ' · DIAN ' + esc(dian) : '') +
            (f.enMaestro ? '' : ' · fuera del maestro') +
          '</div></div>' +
          '<div class="plata">' + money(f.subtotal) + '</div>' +
          '<div class="eje"><span class="eje-lbl">Remisiones</span><span class="eje-val">' + ejeR + '</span></div>' +
          '<div class="eje"><span class="eje-lbl">Sin repartir</span><span class="eje-val">' + ejeP + '</span></div>' +
        '</button>' + (ab ? panelFactura(f) : '');
    }).join('') + '</div>';
    return h;
  }

  /** El panel: LAS DOS MITADES DEL TRABAJO EN UN SOLO SITIO.
   *
   *  Las propuestas de reparto llegan de `factura_sugerencias`, que se pide al
   *  abrir; mientras no lleguen se muestra lo que ya está asignado y se dice que
   *  vienen en camino. Las de remisión se derivan en el navegador del índice de
   *  candidatas, que ya viaja con el tablero. */
  function panelFactura(f) {
    var sug = (sugAbierta && sugAbierta.numero === f.numero) ? sugAbierta : null;
    var h = '<div class="panel"><div class="panel-top">' +
      '<span class="num">' + esc(f.numero) + '</span>' +
      '<span class="meta">' + esc(f.fecha || 'sin fecha') + ' · ' + money(f.subtotal) +
        (clienteDe(f) ? ' · ' + esc(clienteDe(f)) : '') +
        (dianAnormal(f) ? ' · DIAN ' + esc(dianAnormal(f)) : '') + '</span>' +
      (f.pdfUrl ? '<a class="btn-mini" href="' + esc(f.pdfUrl) + '" target="_blank" rel="noopener">Ver PDF</a>' : '') +
      '</div>';

    if (f.notas) h += '<p class="nota-f">notas: “' + esc(f.notas) + '”</p>';
    if (!f.enMaestro) {
      h += '<div class="aviso warn">Esta factura está registrada en una remisión pero <strong>no está ' +
           'en el maestro</strong>: el sync todavía no la trajo. El saldo no se puede verificar.</div>';
    }
    if (sug && (sug.contradicciones || []).length) {
      h += '<div class="aviso warn"><strong>Las dos fuentes no coinciden.</strong>' +
        sug.contradicciones.map(function (c) {
          return '<div style="margin-top:4px;">· <strong>' + esc(c.proyecto || c.archivo) +
                 '</strong> — ' + esc(c.detalle) + '</div>';
        }).join('') +
        '<div style="margin-top:5px;">Puede ser una nota mal escrita o una remisión con el número de ' +
        'factura equivocado. Vale la pena revisarlo antes de asignar.</div></div>';
    }

    h += '<div class="mitades">';

    // ── Mitad 1 · remisiones ──
    var sugRem = remisionesSugeridas(f);
    h += '<div class="mitad"><h4>Remisiones que cubre</h4>' +
      '<p class="h4sub">' + ((f.remisiones || []).length || sugRem.length
        ? (f.remisiones || []).length + ' amarrada(s)' +
          (sugRem.length ? ' · ' + sugRem.length + ' sugerida(s)' : '') +
          '. Amarrarlas congela el documento.'
        : 'Ninguna. Normal en anticipos y actas de obra, que se cobran antes de que salga material.') +
      '</p>';
    h += (f.remisiones || []).slice().sort(porRef('consecutivo')).map(function (r) {
      return '<div class="item hecho"><span class="ico">✓</span>' +
        '<span class="cuerpo"><span class="t">' + esc(r.consecutivo || '(sin consecutivo)') + '</span>' +
          '<span class="d">' + esc(r.proyecto || '') + ' · ' + esc(r.estado || '') + '</span></span>' +
        '<button class="btn-mini quitar" data-desfact="' + esc(r.docId) + '" ' +
          'data-rot="' + esc(r.consecutivo || '') + '" data-fact="' + esc(f.numero) + '">Quitar</button></div>';
    }).join('');
    h += sugRem.slice().sort(porRef('consecutivo')).map(function (r) {
      return '<div class="item sug"><span class="ico">+</span>' +
        '<span class="cuerpo"><span class="t">' + esc(r.consecutivo || '(sin consecutivo)') + '</span>' +
          '<span class="d">' + esc(r.proyecto || '') + ' · sugerida' +
          (r.dias != null ? ' · ' + r.dias + ' d sin cobrar' : '') + '</span></span>' +
        '<button class="btn-mini" data-amarrar="' + esc(r.docId) + '" ' +
          'data-rot="' + esc(r.consecutivo || '') + '" data-fact="' + esc(f.numero) + '">Amarrar</button></div>';
    }).join('');
    h += '</div>';

    // ── Mitad 2 · reparto ──
    h += '<div class="mitad"><h4>Reparto entre proyectos</h4>' +
      '<p class="h4sub">Contra el subtotal. El AIU cuenta.</p>';
    h += (f.reparto || []).map(function (a) {
      return '<div class="item hecho"><span class="ico">✓</span>' +
        '<span class="cuerpo"><span class="t">' + esc(a.proyecto || a.cotizacionArchivo) +
          (a.concepto === 'PROVEEDURIA'
            ? ' <span class="estado prov">proveedur\u00eda</span>' : '') + '</span>' +
          '<span class="d">CB' + esc(a.cb) + (a.version ? '.' + esc(a.version) : '') +
          (a.montoAiu > 0 ? ' · AIU ' + money(a.montoAiu) : '') + '</span></span>' +
        '<span class="monto">' + money((Number(a.monto) || 0) + (Number(a.montoAiu) || 0)) + '</span>' +
        '<button class="btn-mini quitar" data-anular="' + esc(a.asigId) + '" ' +
          'data-etq="' + esc(f.numero + ' · ' + (a.proyecto || a.cotizacionArchivo)) + '">Anular</button></div>';
    }).join('');

    if (!sug) {
      h += '<div class="item sug"><span class="ico">…</span>' +
        '<span class="cuerpo"><span class="d">Buscando contra qué proyectos podría ir…</span></span></div>';
    } else {
      var props = (sug.propuestas || []);
      h += props.map(function (p, i) {
        var fuente = p.confianza === 'AMBAS' ? 'nota + remisión'
          : (p.confianza === 'REMISION' ? 'desde la remisión'
            : (p.confianza === 'OTRA_VERSION' ? 'la nota cita otra versión' : 'desde la nota'));
        return '<div class="item sug"><span class="ico">+</span>' +
          '<span class="cuerpo"><span class="t">' + esc(p.proyecto || p.cotizacionArchivo) + '</span>' +
            '<span class="d">CB' + esc(p.cb) + (p.version ? '.' + esc(p.version) : '') + ' · ' + esc(fuente) +
            (p.nRemisiones ? ' (' + p.nRemisiones + ')' : '') +
            (p.lineaDescripcion ? ' · línea ' + esc(p.linea) : '') + '</span>' +
            (p.nombreCoincide === false
              ? '<span class="d" style="color:#B45309;">⚠ el nombre de la nota no aparece en la línea — verifica</span>'
              : '') + '</span>' +
          '<span class="monto">' + (p.monto ? money(p.monto) : '<span class="cbv">a mano</span>') + '</span>' +
          '<button class="btn-mini" data-aplicar="' + i + '">Asignar</button></div>';
      }).join('');
      if (!props.length && !(f.reparto || []).length) {
        h += '<div class="aviso info">Ni la nota menciona una cotización, ni esta factura está en ' +
             'ninguna remisión. Hay que asignarla a mano — es lo normal en anticipos.</div>';
      }
      (sug.sinResolver || []).forEach(function (s) {
        h += '<div class="item sug"><span class="ico">·</span><span class="cuerpo">' +
          '<span class="t">' + esc(s.ref.texto || (s.ref.tipo + s.ref.cb)) + '</span>' +
          '<span class="d">' + esc(s.detalle) + '</span></span></div>';
      });
    }

    h += '<div class="saldo"><span>Sin repartir</span><span class="' +
      (Math.abs(f.sinAsignar) < 0.5 ? 'cero' : 'queda') + '">' + money(f.sinAsignar) + '</span></div>';
    h += '<div style="margin-top:9px;"><button class="btn-mini" data-manual="' + esc(f.numero) + '">' +
         'Asignar a otro proyecto…</button></div>';
    h += '</div></div></div>';
    return h;
  }

  // ══ VISTA 3 · POR PROYECTO ═══════════════════════════════════════════════
  //
  // Un REPORTE, no una tarea: se mira, no se opera. Por eso es una tabla densa
  // con totales y no una lista de tarjetas con botones.
  function vistaProyecto() {
    var lista = (_datos.cotizaciones || []), tot = _datos.totales || {};
    if (!lista.length) return '<div class="vacio">No hay cotizaciones aprobadas con movimiento.</div>';

    var h = '<div class="fact-cortes">' +
      corte('a', 'Aprobado', money(tot.valorAprobado), 'de las cotizaciones aprobadas') +
      corte('b', 'Facturado', money(tot.facturado),
            tot.aiu > 0 ? 'incluye ' + money(tot.aiu) + ' de AIU' : 'sin AIU registrado') +
      corte('c', 'Por facturar', money(tot.pendiente),
            tot.facturadoDeMas > 0 ? '⚠ ' + money(tot.facturadoDeMas) + ' cobrado de más' : 'lo que falta cobrar') +
      '</div>';

    var filas = lista.slice().sort(function (a, b) {
      var ra = refCotiz(a), rb = refCotiz(b);
      if (!ra && !rb) return String(a.proyecto || '').localeCompare(String(b.proyecto || ''));
      if (!ra) return -1;
      if (!rb) return 1;
      return cmpRef(ra, rb);
    }).map(function (c) {
      var r = c.resumen;
      var chips = '';
      // El AIU mixto se marca, no se corrige: si en la misma cotización unas
      // facturas lo cobran y otras no, la comparación deja de ser limpia.
      // Estimar el faltante sería inventar un cobro.
      if (r.aiuMixto) chips += ' <span class="estado warn" title="Unas facturas de esta cotización cobran AIU y otras no">AIU mixto</span>';
      var pend = r.facturadoDeMas > 0
        ? '<span class="mal">+' + money(r.facturadoDeMas) + '</span>'
        : (r.pendiente > 0 ? '<span class="neg">' + money(r.pendiente) + '</span>' : '<span class="ok">—</span>');
      // La proveeduría se marca en la fila: que un proyecto tenga cobros que no
      // salen de su cotización es justo lo que antes no se veía.
      if (r.adicional > 0) {
        chips += ' <span class="estado prov" title="Cobros que no salen de la cotizaci\u00f3n de acero">' +
                 'con proveedur\u00eda</span>';
      }
      return '<tr>' +
        '<td><span class="proy">' + esc(c.proyecto || c.archivo) + '</span>' + chips +
          '<div class="cbv">CB' + esc(c.cb) + (c.version ? '.' + esc(c.version) : '') + ' · ' + esc(c.estado) + '</div></td>' +
        '<td class="n">' + money(r.valorAprobado) + '</td>' +
        '<td class="n">' + money(r.facturado) + (r.aiu > 0 ? '<div class="cbv">AIU ' + money(r.aiu) + '</div>' : '') + '</td>' +
        '<td class="n">' + pend + '</td>' +
        // ADICIONAL. Sin "pendiente" y sin "de más" a propósito: la proveeduría
        // no tiene valor aprobado contra el cual compararse, y ponerle uno
        // inventado es lo que esta columna viene a evitar.
        '<td class="n">' + (r.adicional > 0
          ? '<span class="prov-val">' + money(r.adicional) + '</span>' +
            '<div class="cbv">' + r.adicionalN + (r.adicionalN === 1 ? ' cobro' : ' cobros') + '</div>'
          : '—') + '</td>' +
        '<td class="n">' + (r.expuesto > 0 ? '<span class="neg">' + money(r.expuesto) + '</span>' : '—') + '</td>' +
        '<td class="n">' + num(r.unidadesDespachadas) + '/' + num(r.unidades) + '</td>' +
        '<td><button class="btn-mini" data-asignar="' + esc(c.archivo) + '" ' +
          'data-proy="' + esc(c.proyecto || c.archivo) + '">Asignar</button></td></tr>';
    }).join('');

    // LAS CABECERAS AGRUPADAS EN DOS BLOQUES, y esa raya es el punto entero de
    // este cambio: lo de la izquierda se compara contra el aprobado; lo de la
    // derecha, no. Sin la separación visual, siete columnas de plata se leen
    // como si todas contaran igual.
    h += '<div class="tabla-wrap"><table class="fact-table">' +
      '<thead><tr>' +
        '<th></th><th class="g1" colspan="3">Del contrato</th>' +
        '<th class="g2">Adicional</th><th colspan="3"></th></tr>' +
      '<tr><th>Proyecto</th><th class="g1">Aprobado</th><th class="g1">Facturado</th>' +
      '<th class="g1">Por facturar</th><th class="g2">Proveedur\u00eda</th>' +
      '<th>Cobrado sin salir</th><th>Despachado</th><th></th></tr></thead>' +
      '<tbody>' + filas + '</tbody>' +
      '<tfoot><tr><td>Total</td><td class="n">' + money(tot.valorAprobado) + '</td>' +
      '<td class="n">' + money(tot.facturado) + '</td>' +
      '<td class="n">' + (tot.facturadoDeMas > 0 ? '<span class="mal">+' + money(tot.facturadoDeMas) + '</span> / ' : '') +
        money(tot.pendiente) + '</td>' +
      '<td class="n">' + (tot.adicional > 0 ? money(tot.adicional) : '—') + '</td>' +
      '<td class="n">' + money(tot.expuesto) + '</td><td></td><td></td></tr></tfoot>' +
      '</table></div>';

    if (tot.adicional > 0) {
      h += '<p class="leyenda"><strong>Adicional</strong> es lo que se le cobr\u00f3 al proyecto y NO sale de su ' +
        'cotizaci\u00f3n: proveedur\u00eda de material distinto al acero, las Q. No tiene "por facturar" ni ' +
        '"cobrado de m\u00e1s" porque no hay valor aprobado contra el cual compararlo \u2014 invent\u00e1rselo ser\u00eda ' +
        'peor que dejarlo sin comparar. Se muestra junto al contrato y nunca sumado con \u00e9l.</p>';
    }
    h += '<p class="leyenda"><strong>Cobrado sin salir</strong> es plata que ya se facturó y cuyo material ' +
      'todavía no ha salido de la planta: anticipos y actas de obra. No es un error — es lo que la empresa ' +
      'debe entregar. Vive aquí, junto al proyecto que le da contexto, y no en los cortes generales.</p>' +
      (tot.conAiuMixto ? '<p class="leyenda">⚠ ' + tot.conAiuMixto +
        ' cotización(es) con AIU mixto: unas facturas lo cobran y otras no.</p>' : '');
    return h;
  }

  /** El backend desplegado es anterior a esta pantalla.
   *
   *  Se distingue de "no hay datos" a propósito: el síntoma es el mismo —una
   *  lista vacía— pero la causa y el arreglo no se parecen en nada, y el mensaje
   *  equivocado manda a correr un sync sobre un Sheet que está bien.
   *
   *  `facturasTotal` sí lo devuelve el backend viejo, así que cuando trae un
   *  número se puede decir cuántas facturas hay de verdad. Es la prueba de que
   *  el problema no son los datos. */
  function avisoBackendViejo() {
    var n = (_datos && _datos.facturasTotal) || 0;
    return '<div class="aviso warn" style="margin:0 0 14px;">' +
      '<strong>Falta subir el backend.</strong> El Apps Script que está respondiendo es anterior a ' +
      'esta pantalla: no devuelve la lista de facturas que necesita.' +
      (n ? ' <strong>Tus datos están bien</strong> — ese mismo backend reporta ' + n +
           ' factura(s) en el maestro.' : '') +
      '</div>' +
      '<div class="aviso info" style="margin:0;">Para arreglarlo:<br>' +
      '1. Pegar <code>apps-script/Remisiones.gs</code> en el editor de Apps Script.<br>' +
      '2. <strong>Implementar › Administrar implementaciones › editar › Nueva versión</strong>. ' +
      'Editar el código no basta: sin versión nueva, la Web App sigue sirviendo la anterior.<br>' +
      '<br>Mientras tanto, <strong>Por cobrar</strong> y <strong>Por proyecto</strong> sí funcionan: ' +
      'salen de datos que el backend viejo también manda.</div>';
  }

  function refCotiz(c) {
    var cb = String(c.cb == null ? '' : c.cb).trim();
    if (!cb || cb === '0') return '';
    var v = String(c.version == null ? '' : c.version).trim();
    return v ? cb + '.' + v : cb;
  }
  function corte(cls, lbl, val, sub) {
    return '<div class="corte ' + cls + '"><div class="lbl">' + esc(lbl) + '</div>' +
      '<div class="val">' + esc(val) + '</div><div class="sub">' + esc(sub) + '</div></div>';
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function pintar() {
    if (!_datos) return;
    // A-01: el badge cuenta plata, no papeleo. Es el número que alguien mira de
    // reojo para decidir si tiene algo que cobrar hoy, así que sumarle las
    // remisiones ya cobradas lo volvía inservible.
    var nCobrar = (_datos.sinFacturar || []).filter(function (r) {
      return !soloRegistro(r);
    }).length;
    var bc = document.getElementById('badgeCobrar');
    bc.textContent = nCobrar;
    bc.className = 'vbadge' + (nCobrar ? '' : ' calmo');
    var bf = document.getElementById('badgeFact');
    if (_backendViejo) {
      // Un "0" aquí se leería como "no hay nada pendiente", que es justo lo que
      // no se puede afirmar: no llegó el dato para saberlo.
      bf.textContent = '!'; bf.className = 'vbadge';
    } else {
      bf.textContent = (_datos.facturas || []).filter(function (f) {
        var e = estadoFactura(f); return !e.repartoOk || e.sugeridas;
      }).length;
      bf.className = 'vbadge calmo';
    }

    Array.prototype.forEach.call(document.querySelectorAll('.vtab'), function (t) {
      t.setAttribute('aria-selected', String(t.getAttribute('data-v') === vista));
    });
    document.getElementById('vista').innerHTML =
      vista === 'cobrar' ? vistaCobrar() : (vista === 'proyecto' ? vistaProyecto() : vistaFacturas());

    // `indeterminate` es una PROPIEDAD, no un atributo: no se puede escribir en
    // el HTML y se pierde en cada repintado. Se aplica acá, justo después de
    // volcar la vista, a partir del `data-medias` que dejó el render.
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-medias]'),
      function (c) { c.indeterminate = true; });

    var b = document.getElementById('buscar');
    if (b && busca) { b.focus(); b.setSelectionRange(busca.length, busca.length); }
  }

  /** Abre una factura y pide sus sugerencias. Se pintan primero los datos que ya
   *  están y se rellena al llegar: abrir no puede quedarse esperando una llamada. */
  function abrirFactura(numero) {
    if (abierta === numero) { abierta = null; sugAbierta = null; pintar(); return; }
    abierta = numero; sugAbierta = null;
    pintar();
    apiFacturaSugerencias(token, numero).then(function (r) {
      if (abierta !== numero) return;           // se cerró mientras llegaba
      sugAbierta = Object.assign({ numero: numero }, r);
      pintar();
    }).catch(function () {
      // Sin sugerencias se puede trabajar igual: se asigna a mano.
      if (abierta === numero) { sugAbierta = { numero: numero, propuestas: [], sinResolver: [] }; pintar(); }
    });
  }

  /** Refresca el tablero y, si hay una factura abierta, sus sugerencias. */
  function refrescar() {
    var n = abierta;
    return cargar(true).then(function () {
      if (n && abierta === n) {
        return apiFacturaSugerencias(token, n).then(function (r) {
          if (abierta === n) { sugAbierta = Object.assign({ numero: n }, r); pintar(); }
        }).catch(function () {});
      }
    });
  }

  // ── Modales ──────────────────────────────────────────────────────────────
  // ══ ASIGNAR LAS SEGURAS ══════════════════════════════════════════════════
  //
  // Dos clics, y el primero no escribe nada. El simulacro trae exactamente lo
  // que el segundo haría; el servidor vuelve a correr la compuerta al escribir,
  // así que lo que se ve acá es una propuesta, no una promesa — si algo cambió
  // en el medio, lo que manda es el segundo cálculo y el informe lo dice.
  var loteAuto = null;   // el simulacro que se está mostrando

  function abrirLoteAuto() {
    modal('<h4>Asignar las seguras</h4>' +
          '<p class="hint"><span class="spinner"></span> Revisando las facturas sin repartir…</p>');
    apiFacturaAsignarLote(token, null, false).then(function (r) {
      loteAuto = r;
      modal(htmlLoteAuto(r, false));
    }).catch(function (e) { cerrarModal(); manejarError(e); });
  }

  function confirmarLoteAuto() {
    // Se mandan los NÚMEROS que se mostraron, no el reparto: el reparto lo
    // recalcula el servidor. Así lo que se aprueba es "estas facturas", que es
    // lo que la persona de verdad miró.
    var nums = (loteAuto && loteAuto.asignadas || []).map(function (a) { return a.numero; });
    if (!nums.length) { cerrarModal(); return; }
    modal('<h4>Asignar las seguras</h4><p class="hint"><span class="spinner"></span> Escribiendo…</p>');
    apiFacturaAsignarLote(token, nums, true).then(function (r) {
      cerrarModal();
      toast(r.escritas
        ? 'Se asignaron ' + r.escritas + (r.escritas === 1 ? ' reparto.' : ' repartos.')
        : 'No se escribió nada: las condiciones cambiaron.', r.escritas ? 'ok' : 'error');
      // Si el segundo cálculo frenó algo que el simulacro daba por bueno, no se
      // esconde: es justo el caso que hay que mirar.
      var perdidas = nums.length - (r.asignadas || []).length;
      if (perdidas > 0) {
        toast(perdidas + (perdidas === 1 ? ' factura quedó' : ' facturas quedaron') +
              ' sin asignar al confirmar. Revísalas en la lista.', 'error');
      }
      loteAuto = null;
      return refrescar();
    }).catch(function (e) { cerrarModal(); manejarError(e); });
  }

  /**
   * Acepta una de las que la compuerta frenó por consecuencia.
   *
   * Se escribe por `factura_asignar`, que es el MISMO camino de siempre con sus
   * mismas validaciones — la compuerta nunca bloqueó esta ruta, solo la
   * automática. No hay ningún salto nuevo que abrir.
   *
   * `origen` conserva de dónde salió el reparto (NOTAS / REMISION / OC) y
   * `sobreAviso` dice que una persona lo aceptó sabiendo lo que decía el aviso.
   * Se separan para que el conteo de "cuántas automáticas hubo que anular" no
   * se contamine con decisiones humanas.
   */
  function aceptarRevisable(i, btn) {
    if (!loteAuto) return;
    var revs = (loteAuto.frenadas || []).filter(function (f) {
      return f.revisable && (f.propuestas || []).length;
    });
    var f = revs[i];
    if (!f) return;
    btn.disabled = true;
    btn.textContent = 'Asignando\u2026';
    var nota = 'Aceptada sobre aviso: pasaba del aprobado';
    Promise.all(f.propuestas.map(function (p) {
      return apiFacturaAsignar(token, f.numero, p.cotizacionArchivo, p.monto, p.montoAiu,
                               p.kgFacturado, p.origen, nota, p.concepto, true);
    })).then(function () {
      // Se quita de la lista en memoria y se repinta el modal: la persona sigue
      // con las demás sin perder el sitio.
      loteAuto.frenadas = (loteAuto.frenadas || []).filter(function (x) { return x !== f; });
      modal(htmlLoteAuto(loteAuto));
      toast(f.numero + ' asignada.', 'ok');
      return refrescar();
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = 'Asignar igual';
      manejarError(e);
    });
  }

  /** Los motivos, en palabras. El código va al lado para poder buscarlo. */
  var MOTIVO_LOTE = {
    YA_TIENE_REPARTO:       'ya tiene reparto',
    SIN_PROPUESTAS:         'no hay contra qué proponerla',
    HAY_SIN_RESOLVER:       'la nota dice algo que no se pudo resolver',
    HAY_CONTRADICCIONES:    'la nota y las remisiones no coinciden',
    CONFIANZA_INSUFICIENTE: 'la propuesta es una suposición, no un dato',
    MONTO_A_MANO:           'el monto no sale de una línea ni de un subtotal',
    SUMA_NO_CUADRA:         'lo propuesto no suma la factura entera',
    SIN_APROBADO:           'el proyecto no tiene valor aprobado',
    PASA_DEL_APROBADO:      'dejaría el proyecto cobrado de más',
    NO_EN_MAESTRO:          'no está en el maestro de facturas',
    RECHAZADA_AL_ESCRIBIR:  'la escritura la rechazó',
  };

  function htmlLoteAuto(r) {
    var asig = r.asignadas || [], fren = r.frenadas || [];
    var h = '<h4>Asignar las seguras</h4>';

    if (!asig.length) {
      h += '<p class="hint">De las ' + r.revisadas + ' revisadas, <strong>ninguna</strong> ' +
           'se puede asignar sola.</p>';
    } else {
      h += '<p class="hint">De las ' + r.revisadas + ' revisadas, <strong>' + asig.length +
           '</strong> se pueden asignar solas. Esto es lo que se va a escribir:</p>' +
           '<div class="lote-lista">' + asig.map(function (a) {
             return '<div class="lote-f"><span class="lote-num">' + esc(a.numero) + '</span>' +
               a.propuestas.map(function (p) {
                 return '<span class="lote-p">' + esc(p.proyecto || p.cotizacionArchivo) +
                        ' <b>' + money(p.monto + p.montoAiu) + '</b></span>';
               }).join('') + '</div>';
           }).join('') + '</div>';
    }

    // ── LAS QUE SE PUEDEN REVISAR ──
    //
    // La compuerta las frenó SOLO por la consecuencia —dejarían al proyecto por
    // encima de lo aprobado— pero la propuesta que calculó está completa. Y
    // pasarse del aprobado no es por sí mismo un error: la factura final no
    // siempre cuadra al peso con la cotización.
    //
    // Antes esto era una línea con números y nada más, así que para aceptar una
    // había que cerrar, buscarla, abrirla y teclear el monto a mano. Van
    // primero, desplegadas, y con su botón.
    var revisables = fren.filter(function (f) { return f.revisable && (f.propuestas || []).length; });
    var resto = fren.filter(function (f) { return revisables.indexOf(f) === -1; });

    if (revisables.length) {
      h += '<div class="lote-rev"><h5>' + revisables.length +
        (revisables.length === 1 ? ' pide' : ' piden') + ' que la mires</h5>' +
        '<p class="hint">Dejar\u00edan el proyecto por encima de lo aprobado. Suele ser que la ' +
        'factura final no cuadra al peso con la cotizaci\u00f3n \u2014 rev\u00edsalas y acepta las que ' +
        'est\u00e9n bien.</p>' +
        revisables.map(function (f, i) {
          return '<div class="lote-r"><div class="lote-rtop">' +
              '<span class="lote-num">' + esc(f.numero) + '</span>' +
              f.propuestas.map(function (p) {
                return '<span class="lote-p">' + esc(p.proyecto || p.cotizacionArchivo) +
                       ' <b>' + money(p.monto + p.montoAiu) + '</b></span>';
              }).join('') +
              '<button class="btn-mini primario" data-rev-ok="' + i + '">Asignar igual</button>' +
            '</div>' +
            '<div class="lote-rnum">Dejar\u00eda el proyecto en <b>' + money(f.quedaria) +
              '</b> contra <b>' + money(f.aprobado) + '</b> aprobado' +
              (f.aprobado > 0 ? ' \u00b7 ' + money(f.quedaria - f.aprobado) + ' de m\u00e1s' : '') +
            '</div></div>';
        }).join('') + '</div>';
    }

    // El RESTO, agrupado por motivo: son las que no se pueden aceptar de un
    // clic porque su propuesta no está completa o no es de fiar. En una lista
    // plana de treinta no se ve cuál es el problema de fondo.
    if (resto.length) {
      var porMotivo = {};
      resto.forEach(function (f) { (porMotivo[f.motivo] = porMotivo[f.motivo] || []).push(f.numero); });
      h += '<details class="lote-fren"><summary>' + resto.length +
           (resto.length === 1 ? ' queda' : ' quedan') + ' para mirar a mano</summary>' +
        Object.keys(porMotivo).map(function (m) {
          return '<div class="lote-m"><span class="lote-mt">' +
            esc(MOTIVO_LOTE[m] || m) + '</span> <span class="lote-mn">' +
            esc(porMotivo[m].slice(0, 12).join(', ')) +
            (porMotivo[m].length > 12 ? ' +' + (porMotivo[m].length - 12) : '') + '</span></div>';
        }).join('') + '</details>';
    }

    h += '<div class="modal-acciones">' +
      '<button class="btn btn-sm" data-auto-no="1">' + (asig.length ? 'Cancelar' : 'Cerrar') + '</button>' +
      (asig.length ? '<button class="btn btn-sm btn-primary" data-auto-ok="1">Asignar ' +
                     asig.length + (asig.length === 1 ? ' factura' : ' facturas') + '</button>' : '') +
      '</div>';
    return h;
  }

  function cerrarModal() { document.getElementById('modalCont').innerHTML = ''; }
  function modal(html) {
    document.getElementById('modalCont').innerHTML =
      '<div class="modal-back" id="modalBack"><div class="modal-box">' + html + '</div></div>';
    document.getElementById('modalBack').addEventListener('click', function (e) {
      if (e.target.id === 'modalBack') cerrarModal();
    });
  }

  /** Pide un motivo. El backend lo EXIGE tanto para quitar una factura como para
   *  anular una asignación, y con razón: sin motivo, después hay que adivinar si
   *  fue un error de digitación o una nota crédito. */
  function pedirMotivo(titulo, detalle, btnOk) {
    return new Promise(function (resolve) {
      modal('<h4>' + esc(titulo) + '</h4><p class="hint">' + esc(detalle) + '</p>' +
        '<div class="campo"><label>Motivo</label>' +
          '<input id="mMotivo" maxlength="300" placeholder="número mal digitado, nota crédito…" autocomplete="off">' +
          '<div class="ayuda">Queda en la auditoría junto a quién lo hizo y cuándo.</div></div>' +
        '<div class="modal-acciones"><button class="btn btn-sm" id="mCancel">Cancelar</button>' +
        '<button class="btn btn-sm btn-primary" id="mOk">' + esc(btnOk) + '</button></div>');
      document.getElementById('mMotivo').focus();
      document.getElementById('mCancel').onclick = function () { cerrarModal(); resolve(null); };
      document.getElementById('mOk').onclick = function () {
        var v = document.getElementById('mMotivo').value.trim();
        if (!v) { toast('Escribe por qué', 'error'); return; }
        cerrarModal(); resolve(v);
      };
    });
  }

  // "Registrar factura" y no "Facturar": esto NO emite nada en Dataico. Anota el
  // número de una factura que YA existe. El verbo importa — "Facturar" sugiere
  // emitir, que es un acto legal ante la DIAN. Ningún botón de este sistema hace
  // eso, y el nombre no puede insinuar que sí.
  //
  // RECIBE UNA LISTA: una factura cubre VARIAS remisiones, y obligar a hacerlo de
  // a una era una vuelta completa por cada documento.
  //
  // YA NO PIDE FECHA NI CUFE: se escribían y no los leía nadie, y el maestro ya
  // los trae de Dataico.
  function abrirRegistrar(docs, numeroSugerido) {
    var lista = [].concat(docs);
    if (!lista.length) return;
    var varias = lista.length > 1;
    var cands = candidatasPara(lista);

    modal('<h4>Registrar factura</h4>' +
      '<p class="hint">' + (varias ? lista.length + ' remisiones — todas quedan con el mismo número'
                                   : esc(lista[0].rotulo)) + '</p>' +
      (varias ? '<div class="campo"><label>Se le pondrá a</label><div style="max-height:120px;overflow:auto;">' +
        lista.map(function (d) { return '<div class="lote-fila"><span>' + esc(d.rotulo) + '</span></div>'; }).join('') +
        '</div></div>' : '') +
      '<div class="aviso info">Esto <strong>no emite nada en Dataico</strong>: anota el número de una factura ' +
        'que ya existe, para dejar constancia de que ' + (varias ? 'esas remisiones quedaron cobradas'
                                                                 : 'esta remisión quedó cobrada') + '.</div>' +
      '<div class="aviso warn">Al registrarla, ' + (varias ? 'las ' + lista.length + ' remisiones quedan ' +
        '<strong>congeladas</strong>' : 'la remisión queda <strong>congelada</strong>') +
        ': no se les podrán cambiar ítems ni cantidades, ni siquiera siendo admin. Si el número queda mal, ' +
        'se les quita la factura y se vuelve a hacer.</div>' +
      '<div class="campo"><label>Número de factura</label>' +
        '<input id="fNumero" placeholder="FE322" autocomplete="off" value="' + esc(numeroSugerido || '') + '">' +
        (cands.length
          ? '<div class="ayuda">Sugeridas para este proyecto:</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:5px;">' +
            cands.slice(0, 6).map(function (c) {
              return '<button type="button" class="btn-mini" data-usarfact="' + esc(c.numero) + '" ' +
                'title="' + esc(c.detalle || '') + '">' + esc(c.numero) + '</button>';
            }).join('') + '</div>'
          : '') +
      '</div>' +
      '<div id="fProgreso" class="ayuda" style="min-height:14px;"></div>' +
      '<div class="modal-acciones"><button class="btn btn-sm" id="fCancel">Cancelar</button>' +
      '<button class="btn btn-sm btn-primary" id="fOk">Registrar</button></div>');

    document.getElementById('fCancel').onclick = cerrarModal;
    Array.prototype.forEach.call(document.querySelectorAll('[data-usarfact]'), function (b) {
      b.onclick = function () {
        var i = document.getElementById('fNumero');
        i.value = b.getAttribute('data-usarfact'); i.focus();
      };
    });

    document.getElementById('fOk').onclick = function () {
      var numero = document.getElementById('fNumero').value.trim();
      if (!numero) { toast('Escribe el número de factura', 'error'); return; }
      // Se bloquea contra el doble clic y se libera SIEMPRE en el `finally`: un
      // rechazo dejaba antes el formulario lleno y el botón muerto, justo donde
      // el mensaje del backend explica cómo corregir.
      var btn = this;
      btn.disabled = true;
      var prog = document.getElementById('fProgreso');
      var hechas = [];

      // UNA POR UNA, no en paralelo: `remFacturar` toma el script lock de Apps
      // Script, así que lanzarlas juntas no las hace concurrentes — las pone a
      // esperarse, con riesgo de que alguna agote los 15 s del `waitLock` y
      // falle por congestión y no por su propio motivo.
      var cadena = Promise.resolve();
      lista.forEach(function (d, i) {
        cadena = cadena.then(function () {
          if (prog) prog.textContent = 'Registrando ' + (i + 1) + ' de ' + lista.length + ': ' + d.rotulo + '…';
          return apiRemisionFacturar(token, d.docId, numero)
            .then(function (r) { hechas.push({ d: d, ok: true, sinCambio: !!r.sinCambio }); })
            .catch(function (e) {
              // Una que falle NO aborta las demás: si la tercera ya estaba
              // facturada con otro número, la cuarta sigue siendo trabajo
              // legítimo. La excepción es la sesión vencida, que las tumbaría
              // todas igual.
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
          marcadas = {};
          toast(bien.length === 1
            ? (bien[0].sinCambio ? 'Ya tenía registrada esa factura' : 'Factura registrada')
            : 'Factura registrada en ' + bien.length + ' remisiones', 'ok');
          return refrescar();
        }
        // Con fallos el modal NO se cierra: el resumen de qué entró y qué no es
        // justo lo que hay que leer, y un toast de tres segundos no alcanza.
        if (prog) {
          prog.innerHTML = hechas.map(function (h) {
            return '<div class="lote-fila"><span>' + esc(h.d.rotulo) + '</span>' +
              (h.ok ? '<span class="bien">registrada</span>'
                    : '<span class="falla">' + esc(h.msg) + '</span>') + '</div>';
          }).join('');
        }
        toast(bien.length + ' registrada(s), ' + mal.length + ' sin registrar', 'error');
        if (bien.length) refrescar();
      }).catch(manejarError).finally(function () { btn.disabled = false; });
    };
  }

  /** El formulario de asignar. `previo` prellena desde una propuesta; se rellena
   *  y NO se envía: quien cobra tiene que ver el monto y decidir el AIU. */
  function abrirAsignar(archivo, proyecto, previo) {
    // Lo que la nota sugiere, si la factura abierta trae una referencia Q. La
    // referencia NO elige el proyecto —eso sería emparejar por nombre— pero sí
    // dice de qué es el cobro.
    var pre = (sugAbierta && sugAbierta.sugiereProveeduria) ? 'PROVEEDURIA' : 'CONTRATO';
    modal('<h4>Asignar factura</h4><p class="hint">' + esc(proyecto) + '</p>' +
      '<div class="campo"><label>Factura</label>' +
        '<input id="aNumero" placeholder="FE322" autocomplete="off" value="' +
          esc((previo && previo.factura) || '') + '">' +
        '<div class="ayuda">Si todavía no está en el maestro se registra igual, pero el saldo no se puede verificar.</div></div>' +
      '<div class="campo"><label>Monto sin AIU</label>' +
        '<input id="aMonto" type="number" step="0.01" min="0" placeholder="0" value="' +
          ((previo && previo.monto) || '') + '"></div>' +
      '<div class="campo"><label>AIU</label>' +
        '<input id="aAiu" type="number" step="0.01" min="0" placeholder="0">' +
        '<div class="ayuda">Déjalo en cero si esta factura no cobró AIU. Se compara contra el aprobado sumando ' +
        'los dos, porque el subtotal de la cotización ya lo incluye.</div></div>' +
      '<div class="campo"><label>Kg facturados (opcional)</label>' +
        '<input id="aKg" type="number" step="0.01" min="0" placeholder="0" value="' +
          ((previo && previo.kg) || '') + '"></div>' +
      // QUÉ se le está cobrando al proyecto. Por defecto el contrato, que es lo
      // normal; proveeduría son las Q —material que no es acero— y no se
      // comparan contra el aprobado porque no tienen uno.
      '<div class="campo"><label>Concepto</label>' +
        '<select id="aConcepto">' +
          '<option value="CONTRATO"' + (pre === 'PROVEEDURIA' ? '' : ' selected') + '>' +
            'Del contrato (la cotización de acero)</option>' +
          '<option value="PROVEEDURIA"' + (pre === 'PROVEEDURIA' ? ' selected' : '') + '>' +
            'Proveeduría — material distinto al acero (Q)</option>' +
        '</select>' +
        '<div class="ayuda">' + (pre === 'PROVEEDURIA'
          ? '<strong>La nota menciona una Q</strong>, así que se propone proveeduría. ' +
            'Cámbialo si no es eso.'
          : 'La proveeduría se muestra aparte en el proyecto: no tiene valor aprobado ' +
            'contra el cual compararse.') + '</div></div>' +
      '<div class="campo"><label>Nota (opcional)</label>' +
        '<input id="aNota" maxlength="300" placeholder="acta de obra 1, anticipo…"></div>' +
      '<div class="modal-acciones"><button class="btn btn-sm" id="aCancel">Cancelar</button>' +
      '<button class="btn btn-sm btn-primary" id="aOk">Asignar</button></div>');

    document.getElementById('aCancel').onclick = cerrarModal;
    document.getElementById(previo && previo.monto ? 'aAiu' : 'aMonto').focus();
    document.getElementById('aOk').onclick = function () {
      var numero = document.getElementById('aNumero').value.trim();
      var monto  = parseFloat(document.getElementById('aMonto').value) || 0;
      var aiu    = parseFloat(document.getElementById('aAiu').value) || 0;
      var kg     = parseFloat(document.getElementById('aKg').value) || 0;
      var nota   = document.getElementById('aNota').value.trim();
      var concepto = document.getElementById('aConcepto').value;
      if (!numero) { toast('Escribe el número de factura', 'error'); return; }
      if (monto + aiu <= 0) { toast('El monto tiene que ser mayor a cero (el AIU cuenta)', 'error'); return; }
      var btn = this;
      btn.disabled = true;
      apiFacturaAsignar(token, numero, archivo, monto, aiu, kg, 'MANUAL', nota, concepto)
        .then(function (r) {
          cerrarModal();
          if (r.facturaConocida === false) {
            toast('Asignada. Ojo: ' + numero + ' todavía no está en el maestro de facturas.', 'info');
          } else if (r.saldo && r.saldo.sinAsignar < -0.5) {
            toast('Asignada, pero ' + numero + ' quedó repartida de más: ' + money(r.saldo.sinAsignar), 'error');
          } else {
            toast('Factura asignada', 'ok');
          }
          return refrescar();
        })
        .catch(manejarError)
        .finally(function () { btn.disabled = false; });
    };
  }

  // ── Interacción ──────────────────────────────────────────────────────────
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button') : null;
    if (!b) return;
    var v, n, i;

    if ((v = b.getAttribute('data-v'))) {
      vista = v; abierta = null; sugAbierta = null; pintar(); return;
    }
    if (b.classList.contains('fchip')) { filtro = b.getAttribute('data-f'); pintar(); return; }
    if (b.getAttribute('data-auto')) { abrirLoteAuto(); return; }
    if (b.getAttribute('data-auto-ok')) { confirmarLoteAuto(); return; }
    if (b.getAttribute('data-auto-no')) { loteAuto = null; cerrarModal(); return; }
    if ((n = b.getAttribute('data-rev-ok')) !== null && n !== '') {
      aceptarRevisable(parseInt(n, 10), b); return;
    }
    if (b.classList.contains('fila')) { abrirFactura(b.getAttribute('data-num')); return; }

    // ── Vista Por cobrar ──
    if (b.getAttribute('data-limpiar')) { marcadas = {}; pintar(); return; }
    if (b.getAttribute('data-lote')) { abrirRegistrar(seleccionadas()); return; }
    if ((n = b.getAttribute('data-usarlote'))) { abrirRegistrar(seleccionadas(), n); return; }

    // ── Panel de la factura ──
    if ((n = b.getAttribute('data-amarrar'))) {
      abrirRegistrar([{ docId: n, rotulo: b.getAttribute('data-rot') || '',
                        archivo: '' }], b.getAttribute('data-fact'));
      return;
    }
    if ((n = b.getAttribute('data-desfact'))) {
      var rot = b.getAttribute('data-rot'), fac = b.getAttribute('data-fact');
      pedirMotivo('Quitar la factura ' + fac,
                  rot + ' — la remisión vuelve a DESPACHADA y podrá editarse otra vez.', 'Quitar')
        .then(function (m) {
          if (!m) return;
          return apiRemisionDesfacturar(token, n, m).then(function () {
            toast('Factura quitada. La remisión volvió a la lista de pendientes.', 'ok');
            return refrescar();
          });
        }).catch(manejarError);
      return;
    }
    if ((n = b.getAttribute('data-anular'))) {
      pedirMotivo('Anular la asignación', b.getAttribute('data-etq') || '', 'Anular').then(function (m) {
        if (!m) return;
        return apiFacturaAsignacionAnular(token, n, m).then(function () {
          toast('Asignación anulada', 'ok');
          return refrescar();
        });
      }).catch(manejarError);
      return;
    }
    if ((i = b.getAttribute('data-aplicar')) !== null && i !== undefined && sugAbierta) {
      var p = (sugAbierta.propuestas || [])[parseInt(i, 10)];
      if (p) {
        abrirAsignar(p.cotizacionArchivo, p.proyecto || p.cotizacionArchivo,
                     { factura: sugAbierta.numero, monto: p.monto, kg: p.kgFacturado });
      }
      return;
    }
    if ((n = b.getAttribute('data-manual'))) {
      // Asignar a un proyecto que no está propuesto: el camino de los anticipos.
      abrirAsignar('', '', { factura: n });
      return;
    }

    // ── Vista Por proyecto ──
    if ((n = b.getAttribute('data-asignar'))) {
      abrirAsignar(n, b.getAttribute('data-proy'));
      return;
    }
  });

  // Las casillas van por delegación, igual que los botones: la vista se repinta
  // entera en cada carga.
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var g = t.getAttribute('data-grupo');
    if (g !== null && g !== undefined && t.type === 'checkbox') {
      (_datos.sinFacturar || []).forEach(function (r) {
        if ((r.cotizacionArchivo || '') !== g || !r.docId) return;
        marcadas[r.docId] = t.checked;
      });
      pintar(); return;
    }
    var d = t.getAttribute('data-rem');
    if (d) { marcadas[d] = t.checked; pintar(); }
  });

  document.addEventListener('input', function (ev) {
    if (ev.target && ev.target.id === 'buscar') { busca = ev.target.value.trim(); pintar(); }
  });

  // `clearSession()` ya borra la fila de sesión en el servidor además del
  // localStorage (api.js), que es lo que cerró R2-08.
  document.getElementById('logoutBtn').addEventListener('click', function () {
    clearSession(); location.href = 'index.html';
  });

  document.getElementById('modNav').classList.remove('hidden');
  cargar();
})();
