// ============================================================
// HOJA DE VIDA DEL PROYECTO — agrupado por consecutivo CB
// ============================================================
//
// UNA SOLA PANTALLA PARA UN PROYECTO. Hasta el 22-sep había dos: esta, y el
// "detalle" que abría Cotizaciones al hacer clic en una tarjeta. Mostraban
// buena parte de lo mismo —unidades, despacho, carpetas— de dos formas
// distintas, y el detalle tenía un botón para abrir esta. Ahora el detalle
// VIVE AQUÍ, dentro del bloque de cada cotización.
//
// LA GRANULARIDAD ES LA QUE MANDA. Esta página es del CB y el detalle era de
// UN archivo: un CB junta varias cotizaciones y versiones (CB572 = IE CALLEJON
// + BAÑOS + PRIMERA INFANCIA). Así que el CB queda arriba —etapas, tarjetas,
// facturas— y cada cotización es un bloque con las tablas del detalle:
//
//   · Producción y despacho — siempre visible, con los datos de esta página.
//   · Cotizado vs planeado y carpetas — se abre a pedido, porque sale de
//     `cotiz_detalle`, una lectura por cotización: abrirlas todas de entrada
//     serían N lecturas del maestro para un CB grande.
//
// Se entra con `?cb=572` y, desde una tarjeta de Cotizaciones, con
// `&archivo=…`: esa cotización sale primera y abierta.
(function () {
  'use strict';

  var session = getSession();
  if (!session || !session.token) { location.href = 'index.html'; return; }
  if (!puedeOperar(session)) { location.href = 'produccion.html'; return; }
  var token = session.token;

  var MESES_COR = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function fmtNum(n,d){ if(n==null||n==='')return '—'; var v=Number(n); if(isNaN(v))return '—'; return v.toLocaleString('es-CO',{minimumFractionDigits:d||0,maximumFractionDigits:d||0}); }
  function fmtMoney(n){ if(n==null||n===''||isNaN(Number(n)))return '—'; return '$'+Number(n).toLocaleString('es-CO',{maximumFractionDigits:0}); }
  function fechaCorta(iso){ if(!iso)return '—'; var p=String(iso).substring(0,10).split('-'); if(p.length<3)return '—'; return parseInt(p[2])+' '+MESES_COR[parseInt(p[1])-1]+' '+p[0]; }
  function nUnidades(n){ return n+(n>1?' unidades':' unidad'); }
  function toast(msg,tipo){
    var c=document.getElementById('toastContainer'), el=document.createElement('div');
    el.style.cssText='pointer-events:auto;background:'+(tipo==='error'?'#DC2626':(tipo==='ok'?'#16A34A':'#071D49'))+';color:#fff;padding:10px 16px;border-radius:10px;font-size:0.82rem;font-weight:600;max-width:320px;';
    el.textContent=msg; c.appendChild(el); setTimeout(function(){el.remove();},4000);
  }
  function manejarError(e) {
    if (e && e.tipo === 'auth') { clearSession(); location.href = 'index.html'; return true; }
    toast((e && e.message) || 'Ocurrió un error', 'error');
    return false;
  }

  // Los estados los deriva `_estadoCotizacion` en el backend — la MISMA función
  // que usan cotizaciones y el cierre de carpetas. Aquí solo se rotulan.
  var ESTADO_TXT = {
    EN_PRODUCCION:'En producción', EN_COLA:'En cola', SIN_COLA:'Aprobado sin cola',
    PRODUCIDA:'Producida', PARCIAL:'Parcial', PAUSADA:'Pausada', SIN_APROBAR:'Sin aprobar',
  };

  // ── Estado de la pantalla ───────────────────────────────────────────────
  var _datos = null;          // respuesta de proyecto_hoja_vida
  var _orden = [];            // cotizaciones en el orden en que se pintan
  var _abiertas = {};         // archivo → true si el bloque de detalle está abierto
  var _det = {};              // archivo → { estado: 'cargando'|'ok'|'error', resp, error }
  var _carpetasTodas = null;  // para el buscador de "vincular otra carpeta"
  var _cb = '', _archivoPedido = '';

  // ════════════════════════════════════════════════════════════════════════
  // Funciones puras — `tests/hoja_vida_pantalla.test.js` las extrae por nombre
  // ════════════════════════════════════════════════════════════════════════

  /** La que se pidió primero; después las aprobadas; después el resto. Dentro
   *  de cada grupo se respeta el orden del backend (por nombre). */
  function ordenCotizaciones(cots, archivoPedido) {
    var pedida = [], aprob = [], resto = [];
    (cots || []).forEach(function (c) {
      if (archivoPedido && c.archivo === archivoPedido) pedida.push(c);
      else if (c.aprobada) aprob.push(c);
      else resto.push(c);
    });
    return pedida.concat(aprob, resto);
  }

  /** Qué bloques arrancan abiertos: la cotización que se pidió, o la única si
   *  el proyecto tiene una sola. Nunca todas: cada una es una lectura aparte. */
  function abiertasIniciales(cots, archivoPedido) {
    var out = {};
    var lista = cots || [];
    var pedida = lista.filter(function (c) { return c.archivo === archivoPedido; })[0];
    if (pedida) out[pedida.archivo] = true;
    else if (lista.length === 1) out[lista[0].archivo] = true;
    return out;
  }

  /** Una fila del comparativo. Diferencia = cotizado − planeado. */
  function filaCmp(label, cot, plan) {
    var dif = cot - plan;
    var cls = dif > 1 ? 'cmp-dif-pos' : 'cmp-dif-ok';
    var txt = Math.abs(dif) < 0.05 ? '—' : (dif > 0 ? fmtNum(dif, 1) : '+' + fmtNum(-dif, 1));
    return '<tr><td>' + esc(label) + '</td><td>' + fmtNum(cot, 1) + '</td><td>' + fmtNum(plan, 1) +
           '</td><td class="' + cls + '">' + txt + '</td></tr>';
  }

  /** Cuánto mide una unidad: en ML, o en casas cuando el envío se partió por casas. */
  function tamanoUnidad(u) {
    if (u.tipoEnvio === 'metros' || !u.esEnvio) return fmtNum(u.mlTotal, 0) + ' ML';
    return u.valorEnvio + (u.valorEnvio > 1 ? ' casas' : ' casa') + ' · ' + fmtNum(u.mlTotal, 0) + ' ML';
  }

  /** En qué va la producción de la unidad, con sus fechas. */
  function produccionUnidad(u) {
    var txt, cls, fechas = '';
    if (u.seccion === 'finalizada') {
      txt = 'Producida'; cls = 'fin';
      fechas = (u.fechaRealInicio ? fechaCorta(u.fechaRealInicio) + ' → ' : '') + fechaCorta(u.fechaReal) +
               (u.diasReales ? ' (' + u.diasReales + ' d)' : '');
    } else if (u.pausada) {
      txt = 'Pausada'; cls = 'pau';
      fechas = u.pausadaDesde ? 'desde ' + fechaCorta(u.pausadaDesde) : '';
    } else if (u.seccion === 'backlog') {
      txt = 'Sin programar'; cls = 'back';
    } else {
      txt = u.enProduccion ? 'En producción' : 'En cola'; cls = u.enProduccion ? 'prod' : 'cola';
      fechas = fechaCorta(u.inicio) + ' → ' + fechaCorta(u.fin);
    }
    return '<span class="badge ' + cls + '">' + esc(txt) + '</span>' +
      (fechas ? ' <span class="f">' + esc(fechas) + '</span>' : '') +
      (u.atrasado ? ' <span class="badge atr">Atrasado</span>' : '') +
      (u.fechaEntrega ? '<div class="f">entrega ' + esc(fechaCorta(u.fechaEntrega)) + '</div>' : '') +
      (u.mlAvance && u.seccion !== 'finalizada'
        ? '<div class="f">' + fmtNum(u.mlAvance, 0) + ' ML de avance</div>' : '') +
      // El HISTORIAL, no solo si está pausada ahora: una unidad que se pausó
      // dos veces y ya terminó no decía nada de eso.
      ((u.historialPausas || []).length
        ? '<div class="f">⏸ ' + esc(pausasTxt(u.historialPausas, hoyBogota())) + '</div>' : '');
  }

  /** Qué salió de la planta para esta unidad, y bajo qué factura. En kg: la
   *  remisión registra peso, y convertir a ML sería inventarlo. */
  function despachoUnidad(u) {
    if (u.despachado) {
      var s = '<strong>' + fmtNum(u.kgKit, 0) + ' kg</strong>';
      if ((u.remisiones || []).length) s += ' · ' + esc(u.remisiones.join(', '));
      if ((u.facturas || []).length)   s += ' · ' + esc(u.facturas.join(', '));
      if (u.sinFacturar) s += ' · <span style="color:#92400E;">' + u.sinFacturar + ' sin facturar</span>';
      return s;
    }
    if (u.borradores) return '<span class="f">remisión en borrador</span>';
    return '<span class="f">sin despachar</span>';
  }

  /** Hoy en Bogotá, YYYY-MM-DD. Para las pausas abiertas: "sigue (N d)". */
  function hoyBogota() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  }

  /** Días de calendario entre dos fechas ISO (solo la parte YYYY-MM-DD). null
   *  si falta alguna. Mismo cálculo que `_factDiasEntre` en el backend. */
  function diasEntre(desde, hasta) {
    var a = String(desde || '').substring(0, 10).split('-');
    var b = String(hasta || '').substring(0, 10).split('-');
    if (a.length !== 3 || b.length !== 3) return null;
    var ta = Date.UTC(+a[0], +a[1] - 1, +a[2]), tb = Date.UTC(+b[0], +b[1] - 1, +b[2]);
    if (isNaN(ta) || isNaN(tb)) return null;
    return Math.round((tb - ta) / 86400000);
  }

  /** Las pausas de una unidad, en una línea: "2 pausas: 3 ago → 5 ago (2 d) ·
   *  20 ago → sigue". El motivo no se guarda al pausar, así que no se muestra. */
  function pausasTxt(lista, hoy) {
    var ps = (lista || []).filter(function (p) { return p && p.desde; });
    if (!ps.length) return '';
    return ps.length + (ps.length === 1 ? ' pausa: ' : ' pausas: ') + ps.map(function (p) {
      var d = diasEntre(p.desde, p.hasta || hoy);
      return fechaCorta(p.desde) + ' → ' + (p.hasta ? fechaCorta(p.hasta) : 'sigue') +
             (d != null ? ' (' + d + ' d)' : '');
    }).join(' · ');
  }

  /**
   * LOS TIEMPOS DEL CICLO: cuánto tardó el proyecto entre cada paso.
   *
   * Cinco hitos, cada uno con la fecha que ya existe en alguna parte:
   *
   *   Aprobada          la última vez que se marcó aprobada (auditoría)
   *   Arranca producción la primera unidad iniciada
   *   Termina producción la última unidad terminada — solo si terminaron TODAS
   *   Primer despacho   la primera remisión firme
   *   Primera factura   la factura más vieja que se le relaciona
   *
   * Un hito sin fecha se dice como tal (`pendiente` o `sin registro`) y NO corta
   * la cadena: el tramo siguiente se mide desde el último hito que sí tiene
   * fecha. Y la factura puede ir ANTES del despacho —un anticipo—; en ese caso
   * los días salen negativos, y es información, no un error.
   *
   * FUNCIÓN PURA.
   */
  function cicloDelProyecto(d) {
    var cots = (d && d.cotizaciones) || [];
    var unidades = [];
    cots.forEach(function (c) { unidades = unidades.concat(c.unidades || []); });
    var min = function (xs) { xs = xs.filter(Boolean).sort(); return xs.length ? xs[0] : null; };
    var max = function (xs) { xs = xs.filter(Boolean).sort(); return xs.length ? xs[xs.length - 1] : null; };
    var solo = function (v) { return v ? String(v).substring(0, 10) : null; };

    var aprob = min(cots.filter(function (c) { return c.aprobada; })
                        .map(function (c) { return solo(c.aprobadaTs); }));
    var inicio = min(unidades.map(function (u) { return solo(u.fechaRealInicio); }));
    var todas = unidades.length > 0 && unidades.every(function (u) { return u.seccion === 'finalizada'; });
    var fin = todas ? max(unidades.map(function (u) { return solo(u.fechaReal); })) : null;
    var FIRMES = { DESPACHADA: 1, ENTREGADA: 1, FACTURADA: 1 };
    var desp = min(((d && d.remisiones) || []).filter(function (r) { return FIRMES[r.estado]; })
                                              .map(function (r) { return solo(r.fecha); }));
    var facts = (d && d.facturas) || {};
    var fact = min(Object.keys(facts).map(function (n) { return solo((facts[n] || {}).fecha); }));

    var hitos = [
      { t: 'Aprobada',           fecha: aprob,  falta: 'sin registro' },
      { t: 'Arranca producción', fecha: inicio, falta: 'pendiente' },
      { t: 'Termina producción', fecha: fin,    falta: inicio ? 'en curso' : 'pendiente' },
      { t: 'Primer despacho',    fecha: desp,   falta: 'pendiente' },
      { t: 'Primera factura',    fecha: fact,   falta: 'pendiente' },
    ];
    // Sin el cobro (PLAN_ACCESO D1) no se sabe cuándo se facturó: el hito se
    // quita en vez de decir "pendiente", que sería un dato y falso.
    if (d && d.cobroOculto) hitos.pop();
    var ultima = null;
    hitos.forEach(function (h) {
      h.dias = (h.fecha && ultima) ? diasEntre(ultima, h.fecha) : null;
      if (h.fecha) ultima = h.fecha;
    });
    var fechas = hitos.map(function (h) { return h.fecha; }).filter(Boolean);
    return { hitos: hitos,
             total: fechas.length > 1 ? diasEntre(min(fechas), max(fechas)) : null };
  }

  /** Lo que dice un evento de la historia, en palabras de la operación. */
  function textoEvento(ev) {
    var d = (ev && ev.d) || {};
    var rm = ev.ref ? ev.ref + ': ' : '';
    switch (ev.accion) {
      case 'COTIZ_MARCAR':
        return (d.aprobada === true || d.aprobada === 'true')
          ? 'Cotización aprobada' + (d.cantidad > 1 ? ' (' + d.cantidad + ' unidades)' : '')
          : 'Se retiró la aprobación';
      case 'COTIZ_VINCULAR':       return d.accion === 'unlink' ? 'Carpeta de producción desvinculada' : 'Carpeta de producción vinculada';
      case 'PROD_COLA_TOGGLE':     return d.enCola === false ? 'Salió de la cola' : 'Entró a la cola';
      case 'PROD_COLA_INICIAR':    return 'Arrancó la producción' + (d.fechaRealInicio ? ' (' + fechaCorta(d.fechaRealInicio) + ')' : '');
      case 'PROD_COLA_PAUSAR':     return 'Pausada' + (d.avanceMl ? ' con ' + fmtNum(d.avanceMl, 0) + ' ML de avance' : '');
      case 'PROD_COLA_REANUDAR':   return 'Reanudada';
      case 'PROD_COLA_FINALIZAR':  return 'Producción terminada' + (d.fechaReal ? ' (' + fechaCorta(d.fechaReal) + ')' : '');
      case 'PROD_COLA_REABRIR':    return 'Se reabrió la producción';
      case 'PROD_ENTREGA':         return d.fecha ? 'Fecha de entrega: ' + fechaCorta(d.fecha) : 'Se quitó la fecha de entrega';
      case 'PROD_ENVIOS_SET':      return d.n ? 'Partida en ' + d.n + ' envíos' : 'Se quitaron los envíos';
      case 'PROD_ENVIO_PARTIR':    return 'Envío partido en ' + (d.partes || '?');
      case 'PROD_COLA_NOTA':       return 'Nota: ' + (d.notaEnvio || d.nota || '(borrada)');
      case 'FACTURA_ASIGNAR':      return (d.factura || 'Factura') + ' asignada: ' +
                                          fmtMoney((Number(d.monto) || 0) + (Number(d.aiu) || 0)) + (d.lote ? ' (en lote)' : '');
      case 'FACTURA_ASIGNACION_ANULAR': return 'Se anuló la asignación de ' + (d.factura || 'una factura');
      case 'FACTURA_CIERRE':       return 'Cobro cerrado' + (d.diferencia ? ' con ' + (d.diferencia > 0 ? '+' : '−') +
                                          fmtMoney(Math.abs(d.diferencia)) + ' frente a la cotización' : '') +
                                          (d.nota ? ' — ' + d.nota : '') + (d.lote ? ' (en lote)' : '');
      case 'FACTURA_CIERRE_ANULAR': return 'Cobro reabierto' + (d.motivo ? ' — ' + d.motivo : '');
      case 'REMISION_ANTIGUA_AGREGADA': return rm + 'registrada del sistema anterior' +
                                          (d.fecha ? ' (' + fechaCorta(d.fecha) + ')' : '');
      case 'REMISION_ANTIGUA_ANULADA':  return rm + 'quitada' + (d.motivo ? ' — ' + d.motivo : '');
      case 'REMISION_CONCILIADA':  return rm + 'conciliada y despachada' + (d.pesoTotalKg ? ' · ' + fmtNum(d.pesoTotalKg, 0) + ' kg' : '');
      case 'REMISION_ESTADO':      return rm + String(d.de || '').toLowerCase().replace('_', ' ') + ' → ' +
                                          String(d.a || '').toLowerCase().replace('_', ' ') + (d.motivo ? ' — ' + d.motivo : '');
      case 'REMISION_FACTURADA':   return rm + 'registrada con ' + (d.factura || 'factura');
      case 'REMISION_DESFACTURADA': return rm + 'se le quitó ' + (d.facturaPrevia || 'la factura') + (d.motivo ? ' — ' + d.motivo : '');
      case 'REMISION_ITEMS_AJUSTADOS': return rm + 'se ajustaron ítems' + (d.motivo ? ' — ' + d.motivo : '');
      default: return String(ev.accion || '');
    }
  }

  var ESTADO_REM = {
    BORRADOR:      { txt: 'Borrador',      cls: 'back' },
    POR_CONCILIAR: { txt: 'Por conciliar', cls: 'pau'  },
    DESPACHADA:    { txt: 'Despachada',    cls: 'cola' },
    ENTREGADA:     { txt: 'Entregada',     cls: 'prod' },
    FACTURADA:     { txt: 'Facturada',     cls: 'fin'  },
    ANULADA:       { txt: 'Anulada',       cls: 'anu'  },
    // Del sistema anterior: solo el número, no hay documento que abrir.
    ANTIGUA:       { txt: 'Sistema anterior', cls: 'ant' },
  };

  /** Una remisión del proyecto. El consecutivo lleva al documento en
   *  Remisiones; un borrador todavía no tiene consecutivo —se asigna al
   *  conciliar— y se nombra por lo que es.
   *
   *  `op.sinCobro`: la respuesta vino sin el cobro (PLAN_ACCESO D1) y la
   *  columna Factura dice solo el número del papel. `op.antiguas`: quien mira
   *  puede quitar una remisión del sistema anterior (solo Dirección). Van por
   *  parámetro y no leídos del módulo, para que la función se pueda probar sola. */
  function filaRemision(rm, op) {
    op = op || {};
    var e = ESTADO_REM[rm.estado] || { txt: rm.estado, cls: 'back' };
    var nombre = rm.consecutivo || (rm.estado === 'ANULADA' ? 'Anulada sin número' : 'Borrador');
    // Una remisión del sistema anterior no tiene documento aquí: el número va
    // sin enlace, y en su lugar se puede quitar si se registró mal.
    var link = rm.antigua
      ? '<span class="n-ant">' + esc(nombre) + '</span>' +
        (op.antiguas
          ? '<div><button class="btn-quitar" data-acc="ant-quitar" data-id="' + esc(rm.antId) + '" ' +
            'data-num="' + esc(rm.consecutivo) + '">Quitar</button></div>'
          : '')
      : (rm.docId
        ? '<a class="a-doc" target="_blank" rel="noopener" href="remisiones.html?doc=' +
            encodeURIComponent(rm.docId) + '">' + esc(nombre) + '</a>'
        : esc(nombre));
    var cotiz = esc(rm.proyecto || '') + (rm.version ? ' <span class="f">v' + esc(rm.version) + '</span>' : '') +
      (rm.envioIdx ? '<div class="f">Envío ' + rm.envioIdx + ' de ' + rm.enviosTotal + '</div>' : '');
    var destino = [rm.municipio, rm.destinatario].filter(Boolean).map(esc).join(' · ') ||
      (rm.antigua && rm.nota ? '<span class="f">' + esc(rm.nota) + '</span>' : '<span class="f">—</span>');
    if (rm.ordenCompra) destino += '<div class="f">OC ' + esc(rm.ordenCompra) + '</div>';
    var factura;
    if (op.sinCobro) {
      factura = rm.facturaNumero ? esc(rm.facturaNumero) : '<span class="f">—</span>';
    } else if (rm.facturaNumero) {
      // REGISTRADA NO ES REPARTIDA: la remisión dice bajo qué factura salió,
      // pero si esa factura no le asignó monto a este proyecto, el proyecto
      // sigue "por facturar". Es lo que se leía como "no tiene factura".
      factura = esc(rm.facturaNumero) + (rm.facturaRepartida ? ''
        : '<div class="aviso-rep">falta asignar el monto</div>');
    } else if (rm.diasSinFacturar > 0 || rm.estado === 'DESPACHADA' || rm.estado === 'ENTREGADA') {
      factura = '<span class="aviso-rep">sin facturar' +
        (rm.diasSinFacturar ? ' · ' + rm.diasSinFacturar + ' d' : '') + '</span>';
    } else {
      factura = '<span class="f">—</span>';
    }
    return '<tr' + (rm.estado === 'ANULADA' ? ' class="anulada"' : '') + '>' +
      '<td>' + link + '</td>' +
      '<td>' + esc(fechaCorta(rm.fecha)) + '</td>' +
      '<td><span class="badge ' + e.cls + '">' + esc(e.txt) + '</span></td>' +
      '<td>' + cotiz + '</td>' +
      '<td>' + destino + '</td>' +
      '<td style="text-align:right;">' + (rm.pesoKg ? fmtNum(rm.pesoKg, 0) + ' kg' : '<span class="f">—</span>') + '</td>' +
      '<td>' + factura + '</td></tr>';
  }

  function filaUnidad(u) {
    var nombre = u.esEnvio ? ('Envío ' + u.envioIdx + ' de ' + u.enviosTotal) : 'Proyecto completo';
    return '<tr><td>' + esc(nombre) +
        (u.notaEnvio ? '<div class="hv-nota">📝 ' + esc(u.notaEnvio) + '</div>' : '') + '</td>' +
      '<td>' + esc(tamanoUnidad(u)) + '</td>' +
      '<td>' + produccionUnidad(u) + '</td>' +
      '<td>' + despachoUnidad(u) + '</td></tr>';
  }

  // ════════════════════════════════════════════════════════════════════════
  // El proyecto (CB): encabezado, etapas, tarjetas, facturas
  // ════════════════════════════════════════════════════════════════════════

  function etapasHtml(d) {
    var t = d.totales;
    var hayAprob = t.aprobadas > 0;
    var hayProd  = d.estadoGlobal === 'EN_PRODUCCION' || t.finalizadas > 0;
    var todoFin  = t.unidades > 0 && t.finalizadas === t.unidades;
    var hayDesp  = t.unidadesDespachadas > 0;
    var todoDesp = t.unidades > 0 && t.unidadesDespachadas === t.unidades;
    // Cobrado del todo: no queda nada por facturar y algo se facturó. El
    // `facturadoDeMas` NO cuenta como completo — es un descuadre, no un logro.
    var todoFact = t.facturado > 0 && t.porFacturar === 0 && !t.facturadoDeMas;
    // Con el cobro CERRADO en todas las aprobadas, la etapa terminó aunque la
    // factura final no haya cuadrado al peso: la diferencia ya tiene motivo.
    var todoCerr = t.aprobadas > 0 && t.cerradas === t.aprobadas;
    var et = [
      { t:'Cotización',  v: t.cotizaciones + (t.cotizaciones===1?' cotización':' cotizaciones'), cls: 'ok' },
      { t:'Aprobación',  v: hayAprob ? t.aprobadas+' aprobada'+(t.aprobadas>1?'s':'') : 'pendiente', cls: hayAprob?'ok':'' },
      { t:'Programación',v: t.unidades ? nUnidades(t.unidades)+' en cola' : 'sin programar', cls: t.unidades?'ok':'' },
      { t:'Producción',  v: todoFin ? 'finalizada' : (hayProd ? 'en curso' : 'pendiente'), cls: todoFin?'ok':(hayProd?'act':'') },
      { t:'Despacho',    v: hayDesp ? (t.unidadesDespachadas+'/'+t.unidades+' · '+fmtNum(t.kgDespachado,0)+' kg')
                                    : 'sin despachar',
                         cls: todoDesp?'ok':(hayDesp?'act':'') },
      { t:'Facturación', v: todoCerr ? fmtMoney(t.facturado) + ' · cobro cerrado'
                          : (t.facturado ? (fmtMoney(t.facturado) +
                              (t.porFacturar ? ' · faltan '+fmtMoney(t.porFacturar) : ''))
                            : 'sin facturar'),
                         cls: (todoFact||todoCerr)?'ok':(t.facturado?'act':'') },
    ];
    if (d.cobroOculto) et.pop();
    return '<div class="hv-etapas">'+et.map(function(e){
      return '<div class="hv-etapa '+e.cls+'"><div class="t">'+esc(e.t)+'</div><div class="v">'+esc(e.v)+'</div></div>';
    }).join('')+'</div>';
  }

  function cabeceraHtml(d) {
    var t = d.totales;
    var titulo = d.nombres.length ? d.nombres.join(' · ') : 'CB'+d.cb;
    return '<div class="hv-head">'+
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">'+
          '<div>'+
            '<div class="hv-cb">CB'+esc(d.cb)+'</div>'+
            '<div class="hv-title">'+esc(titulo)+
              '<span class="hv-estado '+esc(d.estadoGlobal)+'">'+esc(ESTADO_TXT[d.estadoGlobal]||d.estadoGlobal)+'</span>'+
            '</div>'+
            '<div class="hv-sub">'+(d.clienteNombre
                ? '<strong>'+esc(d.clienteNombre)+'</strong>'+(d.cliente?' ('+esc(d.cliente)+')':'')+' · '
                : (d.cliente?'Cliente '+esc(d.cliente)+' · ':''))+
              t.cotizaciones+(t.cotizaciones===1?' cotización':' cotizaciones')+' · '+
              d.carpetas.length+(d.carpetas.length===1?' carpeta':' carpetas')+' de producción</div>'+
          '</div>'+
          '<a href="cotizaciones.html" class="btn btn-ghost btn-sm">← Cotizaciones</a>'+
        '</div>'+
        etapasHtml(d)+
      '</div>';
  }

  function tarjetasHtml(t, sinCobro) {
    return '<div class="hv-cards">'+
        '<div class="hv-card"><div class="label">ML aprobados</div><div class="value">'+fmtNum(t.mlAprobado,0)+'</div>'+
          '<div class="sub">de '+fmtNum(t.mlCotizado,0)+' cotizados</div></div>'+
        '<div class="hv-card" style="border-left-color:var(--cf-success,#16A34A);"><div class="label">ML producidos</div>'+
          '<div class="value">'+fmtNum(t.mlProducido,0)+'</div><div class="sub">archivos EP2 en Drive</div></div>'+
        '<div class="hv-card" style="border-left-color:#7C3AED;"><div class="label">Unidades</div>'+
          '<div class="value">'+t.unidades+'</div><div class="sub">'+t.finalizadas+' finalizadas</div></div>'+
        '<div class="hv-card" style="border-left-color:#D97706;"><div class="label">Valor aprobado</div>'+
          '<div class="value" style="font-size:1.1rem;">'+fmtMoney(t.valorAprobado)+'</div><div class="sub">subtotal sin IVA</div></div>'+
        '<div class="hv-card" style="border-left-color:#0891B2;"><div class="label">Despachado</div>'+
          '<div class="value">'+fmtNum(t.kgDespachado,0)+'</div>'+
          '<div class="sub">kg de kit · '+t.unidadesDespachadas+'/'+t.unidades+' unidades</div></div>'+
        (sinCobro ? '' :
        '<div class="hv-card" style="border-left-color:#16A34A;"><div class="label">Facturado</div>'+
          '<div class="value" style="font-size:1.1rem;">'+fmtMoney(t.facturado)+'</div>'+
          '<div class="sub">'+(t.aiu?'incluye '+fmtMoney(t.aiu)+' de AIU':'sin AIU registrado')+'</div></div>'+
        '<div class="hv-card" style="border-left-color:'+(t.facturadoDeMas?'#DC2626':'#B45309')+';">'+
          '<div class="label">'+(t.facturadoDeMas?'Cobrado de más':'Por facturar')+'</div>'+
          '<div class="value" style="font-size:1.1rem;">'+
            fmtMoney(t.facturadoDeMas || t.porFacturar)+'</div>'+
          '<div class="sub">'+(t.expuesto?fmtMoney(t.expuesto)+' cobrado sin salir':'del valor aprobado')+'</div></div>'+
        // PROVEEDURÍA — las Q. Aparte y nunca sumada al Facturado: no tiene
        // valor aprobado contra el cual medirse. Solo si hay: una tarjeta en
        // cero en cada proyecto sin Q sería ruido.
        (t.adicional > 0
          ? '<div class="hv-card" style="border-left-color:#B45309;"><div class="label">Proveeduría</div>'+
              '<div class="value" style="font-size:1.1rem;">'+fmtMoney(t.adicional)+'</div>'+
              '<div class="sub">'+t.adicionalN+(t.adicionalN===1?' cobro':' cobros')+' aparte del contrato</div></div>'
          : ''))+
      '</div>';
  }

  /** Los envíos de una cotización, para elegir a cuál pertenece la remisión.
   *  Vacío si la cotización no está partida: la remisión es del proyecto
   *  completo. FUNCIÓN PURA. */
  function enviosDeCotizacion(c) {
    return ((c && c.unidades) || []).filter(function (u) { return u.esEnvio; }).map(function (u) {
      var s = String(u.uid || ''), k = s.indexOf('#');
      return { envioId: k < 0 ? '' : s.substring(k + 1),
               label: 'Envío ' + u.envioIdx + ' de ' + u.enviosTotal + ' · ' + fmtNum(u.mlTotal, 0) + ' ML' };
    }).filter(function (e) { return e.envioId; });
  }

  /** El espejo de las reglas de `remAntiguaAgregar`, para decirlas antes de
   *  enviar. Quien decide sigue siendo el servidor. FUNCIÓN PURA. */
  function validarAntiguaLocal(v, primera, hoy) {
    if (!String(v.numero || '').trim()) return 'Escribe el número de la remisión.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v.fecha || ''))) return 'Pon la fecha de la remisión.';
    if (hoy && v.fecha > hoy) return 'La fecha no puede ser en el futuro.';
    if (primera && v.fecha > primera) {
      return 'Es posterior a la primera remisión de este sistema (' + fechaCorta(primera) +
             '): esa se hace en Remisiones, con su documento.';
    }
    if (!v.cotizacionArchivo) return 'Elige la cotización.';
    if (v.pesoKg !== '' && v.pesoKg != null && (isNaN(Number(v.pesoKg)) || Number(v.pesoKg) < 0)) {
      return 'El peso tiene que ser un número positivo.';
    }
    return null;
  }

  // ── El formulario: una capa sencilla, con los estilos de modal del panel ──
  function abrirCapa(html) {
    cerrarCapa();
    var capa = document.createElement('div');
    capa.id = 'hvCapa';
    capa.className = 'modal-overlay';
    capa.innerHTML = '<div class="modal">' + html + '</div>';
    capa.addEventListener('click', function (e) { if (e.target === capa) cerrarCapa(); });
    document.body.appendChild(capa);
    return capa;
  }
  function cerrarCapa() { var c = document.getElementById('hvCapa'); if (c) c.remove(); }

  function abrirAntigua() {
    var cots = (_datos.cotizaciones || []).filter(function (c) { return c.aprobada; });
    if (!cots.length) { toast('Este proyecto no tiene cotizaciones aprobadas.', 'error'); return; }
    var primera = _datos.primeraRemisionSistema || '';
    var hoy = hoyBogota();
    var tope = primera && primera < hoy ? primera : hoy;
    var capa = abrirCapa(
      '<h3 class="capa-t">Remisión del sistema anterior</h3>' +
      '<p class="capa-x">Para los despachos que se hicieron antes de este sistema. Se registra <strong>solo el ' +
        'número</strong>, no un documento: cuenta como despacho del proyecto, pero no tiene detalle ni mueve ' +
        'inventario.' + (primera ? ' Solo fechas hasta el <strong>' + esc(fechaCorta(primera)) +
        '</strong>, cuando empezó este sistema.' : '') + '</p>' +
      '<label class="capa-l">Número<input id="aNum" placeholder="RM-0118" autocomplete="off"></label>' +
      '<label class="capa-l">Fecha<input id="aFec" type="date" max="' + esc(tope) + '"></label>' +
      '<label class="capa-l">Cotización<select id="aCot">' + cots.map(function (c) {
        return '<option value="' + esc(c.archivo) + '">' + esc(c.proyecto || c.archivo) +
               (c.version ? ' (v' + esc(c.version) + ')' : '') + '</option>';
      }).join('') + '</select></label>' +
      '<label class="capa-l" id="aEnvL">Envío<select id="aEnv"></select></label>' +
      '<div class="capa-2"><label class="capa-l">Kg de acero <span class="f">(opcional)</span><input id="aKg" type="number" min="0" step="0.1"></label>' +
      '<label class="capa-l">Factura <span class="f">(opcional)</span><input id="aFac" placeholder="FE120" autocomplete="off"></label></div>' +
      '<label class="capa-l">Nota <span class="f">(opcional)</span><input id="aNota" maxlength="300" placeholder="de dónde sale, quién la tiene…"></label>' +
      '<div id="aErr" class="aviso-rep" style="min-height:1em;"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost btn-sm" id="aNo">Cancelar</button>' +
      '<button class="btn btn-primary btn-sm" id="aSi">Registrar</button></div>');

    var selCot = capa.querySelector('#aCot'), selEnv = capa.querySelector('#aEnv');
    var pintarEnvios = function () {
      var c = cots.filter(function (x) { return x.archivo === selCot.value; })[0];
      var es = enviosDeCotizacion(c);
      capa.querySelector('#aEnvL').style.display = es.length ? '' : 'none';
      selEnv.innerHTML = es.map(function (e) {
        return '<option value="' + esc(e.envioId) + '">' + esc(e.label) + '</option>';
      }).join('');
    };
    selCot.addEventListener('change', pintarEnvios);
    pintarEnvios();
    capa.querySelector('#aNum').focus();
    capa.querySelector('#aNo').onclick = cerrarCapa;
    capa.querySelector('#aSi').onclick = function () {
      var btn = this;
      var v = {
        numero: capa.querySelector('#aNum').value.trim(), fecha: capa.querySelector('#aFec').value,
        cotizacionArchivo: selCot.value, envioId: selEnv.value || '',
        pesoKg: capa.querySelector('#aKg').value, facturaNumero: capa.querySelector('#aFac').value.trim(),
        nota: capa.querySelector('#aNota').value.trim(),
      };
      var e = validarAntiguaLocal(v, primera, hoy);
      if (e) { capa.querySelector('#aErr').textContent = e; return; }
      btn.disabled = true;
      apiRemAntiguaAgregar(token, v).then(function () {
        cerrarCapa(); toast('Remisión ' + v.numero + ' registrada', 'ok'); return cargar();
      }).catch(function (err) {
        btn.disabled = false;
        if (err && err.tipo === 'auth') { manejarError(err); return; }
        capa.querySelector('#aErr').textContent = (err && err.message) || 'No se pudo registrar';
      });
    };
  }

  function quitarAntigua(antId, numero) {
    var capa = abrirCapa(
      '<h3 class="capa-t">Quitar ' + esc(numero) + '</h3>' +
      '<p class="capa-x">No se borra: queda marcada como quitada, con el motivo, y deja de contar como despacho.</p>' +
      '<label class="capa-l">Motivo<input id="qMot" maxlength="300" placeholder="era de otro proyecto, número mal escrito…"></label>' +
      '<div id="qErr" class="aviso-rep" style="min-height:1em;"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost btn-sm" id="qNo">Cancelar</button>' +
      '<button class="btn btn-primary btn-sm" id="qSi">Quitar</button></div>');
    capa.querySelector('#qMot').focus();
    capa.querySelector('#qNo').onclick = cerrarCapa;
    capa.querySelector('#qSi').onclick = function () {
      var m = capa.querySelector('#qMot').value.trim();
      if (!m) { capa.querySelector('#qErr').textContent = 'Escribe por qué se quita.'; return; }
      var btn = this; btn.disabled = true;
      apiRemAntiguaAnular(token, antId, m).then(function () {
        cerrarCapa(); toast(numero + ' quitada', 'ok'); return cargar();
      }).catch(function (err) { btn.disabled = false; manejarError(err); });
    };
  }

  // Cuánto tardó el proyecto entre cada paso. Ver `cicloDelProyecto`.
  function cicloHtml(d) {
    var cy = cicloDelProyecto(d);
    var hitos = cy.hitos.map(function (h, i) {
      var entre = '';
      if (i > 0) {
        entre = '<div class="ciclo-flecha">' + (h.dias == null ? '→'
          : (h.dias < 0 ? Math.abs(h.dias) + ' d antes' : h.dias + ' d') + ' →') + '</div>';
      }
      return entre + '<div class="ciclo-hito' + (h.fecha ? ' hecho' : '') + '">' +
        '<div class="t">' + esc(h.t) + '</div>' +
        '<div class="v">' + (h.fecha ? esc(fechaCorta(h.fecha)) : '<span class="f">' + esc(h.falta) + '</span>') + '</div></div>';
    }).join('');
    return '<div class="card-sec"><h3>Tiempos del ciclo' +
        (cy.total != null ? ' <span class="ciclo-total">· ' + cy.total + ' días de punta a punta</span>' : '') + '</h3>' +
      '<div class="ciclo">' + hitos + '</div>' +
      '<p class="nota-pie">Días de calendario. La fecha de aprobación sale de la auditoría: las cotizaciones ' +
      'aprobadas antes de que existiera dicen "sin registro". Una factura antes del despacho es un anticipo.</p></div>';
  }

  // La historia del proyecto, de las dos auditorías.
  var HIST_CORTA = 25;
  var _histTodo = false;
  function historiaHtml(d) {
    var ev = d.lineaDeTiempo || [];
    var cuerpo;
    if (!ev.length) {
      cuerpo = '<div style="font-size:0.8rem;color:var(--cf-gray-text);">No hay eventos registrados para este proyecto.</div>';
    } else {
      var vis = _histTodo ? ev : ev.slice(0, HIST_CORTA);
      cuerpo = '<div class="hist">' + vis.map(function (e) {
        return '<div class="hist-ev"><div class="hist-cuando">' + esc(fmtTs(e.ts)) + '</div>' +
          '<div class="hist-que">' + esc(textoEvento(e)) +
            '<div class="f">' + esc([e.proyecto, e.envio, e.quien].filter(Boolean).join(' · ')) + '</div></div></div>';
      }).join('') + '</div>' +
      (ev.length > HIST_CORTA
        ? '<button class="det-toggle" data-acc="hist" aria-expanded="' + _histTodo + '">' +
            (_histTodo ? 'Ver solo los últimos ' + HIST_CORTA + ' ▴' : 'Ver los ' + ev.length + ' eventos ▾') + '</button>'
        : '');
    }
    return '<div class="card-sec" id="hv-hist"><h3>Historia del proyecto (' + ev.length + (d.lineaTruncada ? '+' : '') + ')</h3>' +
      cuerpo +
      '<p class="nota-pie">Sale de la auditoría. Lo que pasó antes de que se registrara no aparece' +
      (d.lineaTruncada ? ', y se muestran solo los más recientes' : '') + '.</p></div>';
  }

  /** Un timestamp de auditoría, en hora de Bogotá: "12 ago 2026 · 10:05". */
  function fmtTs(ts) {
    var dt = new Date(ts);
    if (isNaN(dt.getTime())) return String(ts || '');
    var f = dt.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    var h = dt.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });
    return fechaCorta(f) + ' · ' + h;
  }

  // Todas las remisiones del proyecto. Hasta el 22-sep solo aparecían de pasada
  // —el consecutivo de las firmes en la columna de despacho— y no había dónde
  // ver qué papeles tiene la obra, a dónde fueron ni con qué factura.
  function remisionesHtml(d) {
    var lista = d.remisiones || [];
    // Para los proyectos despachados ANTES de este sistema: el número de su
    // remisión vieja, sin crear un documento (ver `remAntiguaAgregar`).
    // Solo Dirección: registrarla lleva la factura, y eso es cobro (D1).
    var opFila = { sinCobro: !!d.cobroOculto, antiguas: esDireccion(session) };
    var botonAnt = opFila.antiguas
      ? '<button class="btn-ant" data-acc="ant-nueva">+ Remisión del sistema anterior</button>' : '';
    if (!lista.length) {
      return '<div class="card-sec"><div class="sec-top"><h3>Remisiones (0)</h3>' + botonAnt + '</div>' +
        '<div style="font-size:0.8rem;color:var(--cf-gray-text);">Este proyecto todavía no tiene remisiones.</div></div>';
    }
    var vivas = lista.filter(function (r) { return r.estado !== 'ANULADA'; }).length;
    return '<div class="card-sec"><div class="sec-top"><h3>Remisiones (' + vivas +
        (vivas !== lista.length ? ' · ' + (lista.length - vivas) + ' anulada' + (lista.length - vivas > 1 ? 's' : '') : '') +
      ')</h3>' + botonAnt + '</div>' +
      '<div style="overflow-x:auto;"><table class="cmp-tabla"><thead><tr>' +
        '<th>Remisión</th><th>Fecha</th><th>Estado</th><th>Cotización</th><th>Destino</th>' +
        '<th style="text-align:right;">Peso</th><th>Factura</th>' +
      '</tr></thead><tbody>' + lista.map(function (rm) { return filaRemision(rm, opFila); }).join('') +
      '</tbody></table></div></div>';
  }

  // Las facturas del proyecto, con lo que se le asignó a cada cotización.
  function facturasHtml(d) {
    var filas = [];
    (d.cotizaciones || []).forEach(function (c) {
      (c.asignaciones || []).forEach(function (a) {
        var f = (d.facturas || {})[a.facturaNumero] || {};
        filas.push({ numero: a.facturaNumero, proyecto: c.proyecto,
                     monto: (Number(a.monto)||0) + (Number(a.montoAiu)||0),
                     aiu: Number(a.montoAiu)||0, kg: Number(a.kgFacturado)||0,
                     fecha: f.fecha || '', dianStatus: f.dianStatus || '',
                     pdfUrl: f.pdfUrl || '', concepto: a.concepto || 'CONTRATO',
                     // Una nota crédito se descuenta: se pinta con signo menos,
                     // igual que ya resta en los totales de arriba.
                     notaCredito: !!a.notaCredito });
      });
    });
    filas.sort(function (a, b) { return String(b.fecha).localeCompare(String(a.fecha)); });
    return '<div class="card-sec"><h3>Facturas ('+filas.length+')</h3>'+
      (filas.length
        ? filas.map(function (f) {
            return '<div class="fld-row"><div class="fld-info">'+
                '<div class="fld-nombre">'+esc(f.numero)+' · '+esc(f.proyecto||'')+
                  (f.concepto==='PROVEEDURIA'?' <span class="prov-tag">proveeduría</span>':'')+
                  (f.notaCredito?' <span class="prov-tag" style="background:#EDE9FE;color:#5B21B6;">nota crédito</span>':'')+'</div>'+
                '<div class="fld-meta">'+esc(fechaCorta(f.fecha))+
                  (f.dianStatus==='DIAN_ACEPTADO'?' · aceptada DIAN':(f.dianStatus?' · '+esc(f.dianStatus):''))+
                  (f.kg?' · '+fmtNum(f.kg,0)+' kg':'')+'</div></div>'+
              '<div style="text-align:right;font-weight:700;font-size:0.82rem;">'+(f.notaCredito?'−':'')+fmtMoney(f.monto)+
                (f.aiu?'<div class="fld-meta">AIU '+fmtMoney(f.aiu)+'</div>':'')+'</div>'+
              (f.pdfUrl
                ? '<a class="fld-btn link" target="_blank" rel="noopener" href="'+esc(f.pdfUrl)+'">PDF</a>' : '')+
            '</div>';
          }).join('')
        : '<div style="font-size:0.8rem;color:var(--cf-gray-text);">Todavía no se ha asignado ninguna factura a este proyecto. '+
          'Se hace desde <a href="facturacion.html">Facturación</a>.</div>')+
    '</div>';
  }

  // ════════════════════════════════════════════════════════════════════════
  // Cada cotización: un bloque con las tablas del detalle
  // ════════════════════════════════════════════════════════════════════════

  function cotizacionHtml(c, i) {
    var abierta = !!_abiertas[c.archivo];
    var cant = c.cantidad || 1;
    var fact = (c.aprobada && c.facturacion)
      ? '<div class="hv-cot-meta">'+
          'Facturado '+fmtMoney(c.facturacion.facturado)+
          (c.facturacion.aiu?' (AIU '+fmtMoney(c.facturacion.aiu)+')':'')+
          (c.facturacion.facturadoDeMas
            ? ' · <span style="color:#DC2626;font-weight:700;">'+fmtMoney(c.facturacion.facturadoDeMas)+' de más</span>'
            : (c.facturacion.pendiente ? ' · faltan '+fmtMoney(c.facturacion.pendiente) : ' · saldada'))+
          (c.facturacion.expuesto
            ? ' · <span style="color:#B45309;">'+fmtMoney(c.facturacion.expuesto)+' cobrado sin salir</span>' : '')+
          (c.facturacion.aiuMixto
            ? ' · <span style="color:#92400E;" title="Unas facturas cobran AIU y otras no">AIU mixto</span>' : '')+
          (c.facturacion.adicional > 0
            ? ' · <span class="prov">+ '+fmtMoney(c.facturacion.adicional)+' de proveeduría</span>' : '')+
        '</div>'
      : '';
    // El cierre de cobro, si lo tiene: la diferencia con la cotización ya está
    // explicada, y aquí se dice con qué motivo.
    if (c.cierre) {
      var dCi = Number(c.cierre.diferencia) || 0;
      fact += '<div class="hv-cierre">✓ Cobro cerrado · ' +
        esc((_datos.motivosCierre || {})[c.cierre.motivo] || c.cierre.motivo) +
        (Math.abs(dCi) >= 0.5 ? ' · ' + (dCi > 0 ? '+' : '−') + fmtMoney(Math.abs(dCi)) + ' frente a la cotización' : '') +
        ' · ' + esc(fechaCorta(c.cierre.cerradoTs)) +
        (c.cierre.nota ? '<div class="hv-nota" style="color:#0E7490;">' + esc(c.cierre.nota) + '</div>' : '') +
        '</div>';
    }

    var unidades = (c.unidades || []).length
      ? '<h4 class="sub-h">Producción y despacho</h4>'+
        '<div style="overflow-x:auto;"><table class="cmp-tabla"><thead><tr>'+
          '<th>Unidad</th><th>Tamaño</th><th>Producción</th><th>Despachado (kg)</th>'+
        '</tr></thead><tbody>'+c.unidades.map(filaUnidad).join('')+'</tbody></table></div>'
      : '';

    return '<div class="card-sec cot-bloque'+(c.archivo===_archivoPedido?' pedida':'')+'" id="cot-'+i+'">'+
      '<div class="hv-cot-top">'+
        '<span class="hv-cot-nom">'+esc(c.proyecto||'(sin nombre)')+'</span>'+
        '<span class="hv-cot-cb">CB'+esc(_datos.cb)+(c.version?'.'+esc(c.version):'')+'</span>'+
        '<span class="'+(c.aprobada?'pill-aprob':'pill-noaprob')+'">'+(c.aprobada?'Aprobada':'No aprobada')+'</span>'+
        (c.aprobada && c.estado
          ? '<span class="hv-estado '+esc(c.estado)+'" style="margin-left:0;font-size:0.64rem;padding:2px 8px;">'+
              esc(ESTADO_TXT[c.estado]||c.estado)+'</span>' : '')+
        '<span style="margin-left:auto;font-size:0.74rem;color:var(--cf-gray-text);">'+esc(fechaCorta(c.fecha))+'</span>'+
      '</div>'+
      '<div class="hv-cot-meta">'+nUnidades(cant)+' · '+fmtNum(c.mlTotal,0)+' ML · '+fmtMoney(c.subtotal)+' c/u'+
        (c.vinculadas?' · 🔗 '+c.vinculadas+' carpeta'+(c.vinculadas>1?'s':''):' · sin carpeta vinculada')+'</div>'+
      fact+
      (c.notas?'<div class="hv-nota">📝 '+esc(c.notas)+'</div>':'')+
      unidades+
      '<button class="det-toggle" data-acc="toggle" data-i="'+i+'" aria-expanded="'+abierta+'">'+
        (abierta ? 'Ocultar cotizado vs planeado y carpetas ▴' : 'Cotizado vs planeado y carpetas ▾')+
      '</button>'+
      (abierta ? '<div class="det-cuerpo">'+detalleHtml(c, i)+'</div>' : '')+
    '</div>';
  }

  /** Lo que antes era el "detalle" de Cotizaciones: comparativo y carpetas. */
  function detalleHtml(c, i) {
    var st = _det[c.archivo];
    if (!st || st.estado === 'cargando') {
      return '<div style="text-align:center;padding:24px;"><span class="spinner" ' +
             'style="border-color:rgba(0,0,0,0.1);border-top-color:var(--cf-blue);"></span></div>';
    }
    if (st.estado === 'error') {
      return '<p style="color:var(--cf-error);font-weight:600;font-size:0.82rem;margin:8px 0 0;">'+esc(st.error)+'</p>';
    }
    var resp = st.resp, q = resp.cotizadoPorCasa, plan = resp.planeado;
    var cant = (resp.cotizacion && resp.cotizacion.cantidad) || 1;

    // Comparativo POR UNIDAD. La carpeta de producción contiene los archivos de
    // UNA unidad y esos mismos archivos se reutilizan para las demás unidades
    // iguales del proyecto. Por eso NO se multiplica por la cantidad: hacerlo
    // compararía N unidades cotizadas contra 1 unidad de archivos.
    var nCarpetas = (resp.vinculadas || []).length;
    var rows = '', totCot = 0, sumPlan = 0;
    ['0.75', '0.95', '1.15'].forEach(function (cal) {
      var cot = q.c90[cal] || 0, pl = plan.c90[cal] || 0;
      totCot += cot; sumPlan += pl;
      rows += filaCmp('C90-37 · ' + cal, cot, pl);
    });
    var c140cot = (q.c140['0.75'] || 0) + (q.c140['0.95'] || 0) + (q.c140['1.15'] || 0);
    if (c140cot === 0 && q.c140.total_old) c140cot = q.c140.total_old;
    var c140plan = plan.c140.total || 0;
    if (c140cot > 0 || c140plan > 0) {
      totCot += c140cot; sumPlan += c140plan;
      rows += filaCmp('C140-46', c140cot, c140plan);
    }
    var otros = Math.round((plan.total - sumPlan) * 100) / 100;
    if (otros > 0.05) rows += filaCmp('Otros / sin clasificar', 0, otros);

    var alcance = nCarpetas === 0
      ? '<span style="color:#92400E;">Sin carpetas vinculadas — se muestra lo cotizado por 1 unidad. Vincula una carpeta abajo para comparar.</span>'
      : 'Comparación <strong>por unidad</strong>' + (cant > 1
          ? ' — los archivos de la carpeta se reutilizan para las ' + cant + ' unidades del proyecto (total a producir: ' +
            fmtNum((plan.total || 0) * cant, 1) + ' ML).'
          : '.');

    var html =
      '<h4 class="sub-h">Cotizado vs planeado (metros lineales)</h4>' +
      '<p style="font-size:0.75rem;font-weight:600;margin:0 0 10px;">' + alcance + '</p>' +
      '<div style="overflow-x:auto;"><table class="cmp-table">' +
      '<thead><tr><th>Perfil · calibre</th><th>Cotizado (1 unidad)</th><th>Planeado</th><th>Diferencia</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '<tfoot>' + filaCmp('TOTAL', totCot, plan.total || 0) + '</tfoot>' +
      '</table></div>' +
      '<p class="nota-pie">"Planeado" = suma de EP2 exportados en las carpetas vinculadas (lo que se enviará a producir, aún no lo fabricado). "Diferencia" = cotizado − planeado; en verde cuando el plan cubre lo cotizado.</p>';

    // Carpetas de ESTA cotización. Antes la hoja de vida las mostraba juntas
    // para todo el CB y sin poder quitarlas; el detalle las mostraba por
    // cotización y con el botón. Queda la segunda: es la que sirve para actuar.
    html += '<h4 class="sub-h">Carpetas vinculadas (' + nCarpetas + ')</h4>' +
      (nCarpetas
        ? resp.vinculadas.map(function (f) {
            return '<div class="fld-row"><div class="fld-info"><div class="fld-nombre">' + esc(f.nombre) + '</div>' +
              '<div class="fld-meta">' + esc(fechaCorta(f.fecha)) + ' · ' + fmtNum(f.metrosTotal, 1) + ' ML · ' + esc(f.estado) + '</div></div>' +
              '<a class="fld-btn" target="_blank" rel="noopener" href="https://drive.google.com/drive/folders/' +
                esc(f.carpetaId) + '">Drive</a>' +
              // Vincular y quitar carpetas es de Dirección (25-sep): el administrativo las ve.
              (esDireccion(session)
                ? '<button class="fld-btn unlink" data-acc="unlink" data-i="' + i + '" data-carpeta="' + esc(f.carpetaId) + '">Quitar</button>'
                : '') + '</div>';
          }).join('')
        : '<div style="font-size:0.8rem;color:var(--cf-gray-text);">Aún no hay carpetas de producción vinculadas.</div>');

    if (!esDireccion(session)) return html;   // ver, sí; vincular, no
    // Vincular exige cotización aprobada (`handleCotizVincular`). Antes se
    // ofrecía igual y el backend rechazaba al hacer clic; ahora se dice antes.
    if (!c.aprobada) {
      html += '<p class="nota-pie">Para vincular carpetas, aprueba primero la cotización en ' +
              '<a href="cotizaciones.html">Cotizaciones</a>.</p>';
      return html;
    }
    if ((resp.sugerencias || []).length) {
      html += '<h4 class="sub-h">Sugerencias (código CB' + esc(_datos.cb) + ')</h4>' +
        resp.sugerencias.map(function (f) {
          return '<div class="fld-row"><div class="fld-info"><div class="fld-nombre">' + esc(f.nombre) + '</div>' +
            '<div class="fld-meta">' + esc(fechaCorta(f.fecha)) + ' · ' + fmtNum(f.metrosTotal, 1) + ' ML</div></div>' +
            '<button class="fld-btn link" data-acc="link" data-i="' + i + '" data-carpeta="' + esc(f.carpetaId) + '">Vincular</button></div>';
        }).join('');
    }
    html += '<h4 class="sub-h">Vincular otra carpeta</h4>' +
      '<input type="text" data-buscar="' + i + '" placeholder="Buscar carpeta por nombre…" style="width:100%;margin-bottom:8px;">' +
      '<div id="res-' + i + '"></div>';
    return html;
  }

  function render() {
    var d = _datos;
    _orden = ordenCotizaciones(d.cotizaciones, _archivoPedido);
    document.title = 'COLFRAME — ' + (d.nombres.length ? d.nombres.join(' · ') : 'CB' + d.cb);
    document.getElementById('hvBody').innerHTML =
      cabeceraHtml(d) +
      tarjetasHtml(d.totales, !!d.cobroOculto) +
      cicloHtml(d) +
      '<h3 class="sec-h">Cotizaciones del proyecto (' + d.totales.cotizaciones + ')</h3>' +
      _orden.map(cotizacionHtml).join('') +
      remisionesHtml(d) +
      (d.cobroOculto ? '' : facturasHtml(d)) +
      historiaHtml(d);
  }

  /** Repinta solo el bloque de una cotización. El buscador vive adentro, así que
   *  repintar la página entera en cada respuesta le quitaría el foco a quien escribe. */
  function repintarBloque(i) {
    var el = document.getElementById('cot-' + i);
    if (!el) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = cotizacionHtml(_orden[i], i);
    el.parentNode.replaceChild(tmp.firstChild, el);
  }

  // ── Datos ───────────────────────────────────────────────────────────────
  function cargarDetalle(archivo) {
    _det[archivo] = { estado: 'cargando' };
    return apiCotizDetalle(token, archivo).then(function (resp) {
      _det[archivo] = { estado: 'ok', resp: resp };
    }).catch(function (e) {
      if (e && e.tipo === 'auth') { manejarError(e); return; }
      _det[archivo] = { estado: 'error', error: (e && e.message) || 'Error al cargar el detalle' };
    }).then(function () {
      var i = _orden.map(function (c) { return c.archivo; }).indexOf(archivo);
      if (i > -1) repintarBloque(i);
    });
  }

  /** Todo de nuevo: tras vincular o quitar cambian el conteo de carpetas, los
   *  ML producidos del CB y el comparativo. Solo se relee el detalle de los
   *  bloques abiertos. */
  function cargar() {
    return apiProyectoHojaVida(token, _cb).then(function (d) {
      _datos = d;
      _det = {};
      render();
      Object.keys(_abiertas).forEach(function (a) { if (_abiertas[a]) cargarDetalle(a); });
    });
  }

  function toggle(i) {
    var c = _orden[i];
    if (!c) return;
    _abiertas[c.archivo] = !_abiertas[c.archivo];
    if (_abiertas[c.archivo] && !_det[c.archivo]) cargarDetalle(c.archivo);
    repintarBloque(i);
  }

  function vincular(i, carpetaId, accion, btn) {
    var c = _orden[i];
    if (!c) return;
    btn.disabled = true;
    apiCotizVincular(token, c.archivo, carpetaId, accion).then(function () {
      toast(accion === 'link' ? 'Carpeta vinculada' : 'Carpeta quitada', 'ok');
      _carpetasTodas = null;
      return cargar();
    }).catch(function (e) { btn.disabled = false; manejarError(e); });
  }

  function buscarCarpetas(i, q) {
    var cont = document.getElementById('res-' + i);
    if (!cont) return;
    q = String(q || '').trim().toLowerCase();
    if (q.length < 2) { cont.innerHTML = '<div class="fld-meta">Escribe al menos 2 letras…</div>'; return; }
    var pintar = function (lista) {
      var res = lista.filter(function (p) { return String(p.nombre || '').toLowerCase().indexOf(q) > -1; }).slice(0, 12);
      cont.innerHTML = !res.length ? '<div class="fld-meta">Sin coincidencias.</div>' :
        res.map(function (p) {
          return '<div class="fld-row"><div class="fld-info"><div class="fld-nombre">' + esc(p.nombre) + '</div>' +
            '<div class="fld-meta">' + esc(fechaCorta(p.fecha)) + ' · ' + fmtNum(p.metrosTotal, 1) + ' ML</div></div>' +
            '<button class="fld-btn link" data-acc="link" data-i="' + i + '" data-carpeta="' + esc(p.carpetaId) + '">Vincular</button></div>';
        }).join('');
    };
    if (_carpetasTodas) { pintar(_carpetasTodas); return; }
    cont.innerHTML = '<div class="fld-meta">Cargando carpetas…</div>';
    apiProdProyectosList(token, {}).then(function (r) {
      _carpetasTodas = r.proyectos || [];
      pintar(_carpetasTodas);
    }).catch(manejarError);
  }

  // ── Init ────────────────────────────────────────────────────────────────
  function init() {
    document.getElementById('modNav').classList.remove('hidden');
    document.getElementById('logoutBtn').addEventListener('click', function(){ clearSession(); location.href='index.html'; });

    var qs = new URLSearchParams(location.search);
    _cb = qs.get('cb') || '';
    _archivoPedido = qs.get('archivo') || '';
    if (!_cb) {
      document.getElementById('hvBody').innerHTML =
        '<div class="card-sec"><h3>Hoja de vida</h3><p style="font-size:0.85rem;color:var(--cf-gray-text);margin:0;">'+
        'Abre la hoja de vida de un proyecto desde Cotizaciones o Programación.</p></div>';
      return;
    }

    // Un despachador por evento, puesto UNA vez sobre #hvBody, que no se
    // repinta: lo de adentro sí, y así ningún botón queda mudo (R6-01).
    var body = document.getElementById('hvBody');
    body.addEventListener('click', function (e) {
      var el = e.target.closest('[data-acc]');
      if (!el || !body.contains(el)) return;
      var i = parseInt(el.dataset.i, 10);
      if (el.dataset.acc === 'hist') {
        _histTodo = !_histTodo;
        var sec = document.getElementById('hv-hist');
        if (sec) { var tmp = document.createElement('div'); tmp.innerHTML = historiaHtml(_datos); sec.parentNode.replaceChild(tmp.firstChild, sec); }
        return;
      }
      if (el.dataset.acc === 'ant-nueva') { abrirAntigua(); return; }
      if (el.dataset.acc === 'ant-quitar') { quitarAntigua(el.dataset.id, el.dataset.num || ''); return; }
      if (el.dataset.acc === 'toggle') toggle(i);
      else if (el.dataset.acc === 'link' || el.dataset.acc === 'unlink') vincular(i, el.dataset.carpeta, el.dataset.acc, el);
    });
    body.addEventListener('input', function (e) {
      var el = e.target.closest('[data-buscar]');
      if (el) buscarCarpetas(parseInt(el.dataset.buscar, 10), el.value);
    });

    apiProyectoHojaVida(token, _cb).then(function (d) {
      _datos = d;
      _abiertas = abiertasIniciales(d.cotizaciones, _archivoPedido);
      render();
      Object.keys(_abiertas).forEach(cargarDetalle);
    }).catch(function(e){
      if (manejarError(e)) return;
      document.getElementById('hvBody').innerHTML =
        '<div class="card-sec"><p style="color:var(--cf-error);font-weight:600;margin:0;">'+esc((e&&e.message)||'Error al cargar')+'</p></div>';
    });
  }
  init();
})();
