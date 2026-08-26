// ============================================================
// PROGRAMACIÓN — calendario de producción (cola secuencial)
// ============================================================
(function () {
  'use strict';

  var session = getSession();
  if (!session || !session.token) { location.href = 'index.html'; return; }
  if (!session.esAdmin) { location.href = 'produccion.html'; return; }
  var token = session.token;

  var _data = null;            // respuesta de prod_cola_get
  var _festivos = {};          // set ISO
  var _exc = {};               // ISO → {laborable, nota}
  var _dayItems = {};          // ISO → [proyectos que tocan ese día]
  var _mesY = 0, _mesM = 0;    // mes visible (M: 0-11)
  var _verFinalizados = false; // interruptor: incluir el histórico en el calendario

  var MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  var MESES_COR = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  var DOW = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
  var PALETA_GANTT = ['#0072CE','#16A34A','#DB2777','#D97706','#7C3AED','#0891B2','#DC2626','#4F46E5','#059669','#CA8A04'];

  // ── Utilidades ──
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function toast(msg, tipo){
    var c=document.getElementById('toastContainer'), el=document.createElement('div');
    var bg=tipo==='error'?'#DC2626':(tipo==='ok'?'#16A34A':'#071D49');
    el.style.cssText='pointer-events:auto;background:'+bg+';color:#fff;padding:10px 16px;border-radius:10px;font-size:0.82rem;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,0.2);max-width:320px;';
    el.textContent=msg; c.appendChild(el);
    setTimeout(function(){el.style.opacity='0';el.style.transition='opacity .3s';},2600);
    setTimeout(function(){el.remove();},3000);
  }
  function manejarError(e){ if(e&&e.tipo==='auth'){clearSession();location.href='index.html';return;} toast((e&&e.message)?e.message:'Ocurrió un error','error'); }
  function fmtNum(n,d){ if(n==null||n==='')return '—'; var v=Number(n); if(isNaN(v))return '—'; return v.toLocaleString('es-CO',{minimumFractionDigits:d||0,maximumFractionDigits:d||0}); }
  function fechaCorta(iso){ if(!iso)return '—'; var p=String(iso).substring(0,10).split('-'); if(p.length<3)return '—'; return parseInt(p[2])+' '+MESES_COR[parseInt(p[1])-1]; }
  function fmtDias(n){ var v=Number(n); if(isNaN(v))return '—'; return v.toLocaleString('es-CO',{maximumFractionDigits:1})+(v===1?' día':' días'); }
  // Ritmo real (throughput de las últimas unidades finalizadas) vs el configurado.
  // Ayuda a saber si el ritmo con el que se calcula el Gantt es realista.
  function renderRitmoReal(){
    var el = document.getElementById('ritmoRealInfo');
    if(!el) return;
    var rr = _data.config && _data.config.ritmoReal;
    if(!rr){ el.textContent=''; el.className='ritmo-real-info'; return; }
    var configurado = _data.config.ritmoMlDia;
    var pct = configurado>0 ? Math.round(rr.valor/configurado*100) : null;
    var cls = 'ritmo-real-info' + (pct==null ? '' : pct<85 ? ' bajo' : pct>115 ? ' alto' : ' ok');
    el.className = cls;
    // "días de producción" = días hábiles DISTINTOS con alguna unidad abierta. No
    // es la suma de los tramos: varios proyectos comparten días, y sumarlos
    // inflaba el divisor y hundía el ritmo (medido: 894 contra 1.191 ML/día).
    var base = 'Últimas '+rr.n+' unidades finalizadas ('+fechaCorta(rr.desde)+' → '+fechaCorta(rr.hasta)+'): '+
               fmtNum(rr.ml,0)+' ML en '+rr.dias+' días de producción.';
    el.title = (rr.metodo === 'duracion')
      ? base+'\nDías de producción = días hábiles distintos con alguna unidad abierta; un día con varios proyectos a la vez cuenta una sola vez.'+
        (rr.diasPausados ? '\n('+rr.diasPausados+' día(s) pausado(s) descontado(s).)' : '')+
        (rr.sinFechaInicio ? '\n('+rr.sinFechaInicio+' unidad(es) sin fecha de inicio quedaron fuera del cálculo.)' : '')
      : base+'\n⚠ Medido por salida de planta entre la primera y la última finalización: incluye tiempos muertos, así que SUBESTIMA el ritmo. Marca "Iniciar producción" en los proyectos para medirlo por duración real.';
    el.textContent = 'Ritmo real: '+fmtNum(rr.valor,0)+' ML/día'+(pct!=null?' ('+pct+'% del configurado)':'')+
                     (rr.metodo === 'throughput' ? ' ~' : '');
  }
  function metaAjustes(c){
    var s = '';
    if(c.ritmoOvr) s += ' · ritmo propio '+fmtNum(c.ritmoOvr,0)+' ML/d';
    if(c.fechaInicioMin) s += ' · no antes de '+fechaCorta(c.fechaInicioMin);
    return s;
  }
  // ── Helpers de unidad (proyecto entero o envío) ──
  function envioBadge(c){ return c.esEnvio ? ' <span class="envio-badge">Envío '+c.envioIdx+'/'+c.enviosTotal+'</span>' : ''; }
  function etiquetaUnidad(c){ return (c.proyecto||'') + (c.esEnvio ? ' — Envío '+c.envioIdx+'/'+c.enviosTotal : ''); }
  function nUnidades(n){ return n+(n>1?' unidades':' unidad'); }
  // ── Menú ⋯ por fila (agrupa las acciones poco frecuentes) ──
  function rowMenu(inner){
    return '<div class="row-actions">'+
      '<button class="row-menu-btn" title="Más acciones" aria-label="Más acciones">⋯</button>'+
      '<div class="row-menu">'+inner+'</div>'+
    '</div>';
  }
  function cerrarMenus(){
    document.querySelectorAll('.row-menu.open').forEach(function(m){ m.classList.remove('open'); });
  }
  function bindRowMenus(body){
    // Los enlaces del menú abren en otra pestaña: cerrar el menú al usarlos
    // para no dejarlo colgado al volver.
    body.querySelectorAll('.row-menu a.menu-link').forEach(function(a){
      a.addEventListener('click', function(){ cerrarMenus(); });
    });
    body.querySelectorAll('.row-menu-btn').forEach(function(b){
      b.addEventListener('click', function(e){
        e.stopPropagation();
        var menu = b.parentNode.querySelector('.row-menu');
        var abierto = menu.classList.contains('open');
        cerrarMenus();
        if(!abierto) menu.classList.add('open');
      });
    });
  }
  // Nombre del proyecto enlazado a su hoja de vida (agrupada por consecutivo CB).
  function nombreProyectoHtml(c){
    return '<a class="cola-proy-link" href="proyecto.html?cb='+encodeURIComponent(c.consecutivo)+'"'+
      ' target="_blank" rel="noopener" title="Ver hoja de vida de CB'+esc(c.consecutivo)+'">'+
      esc(c.proyecto)+' <span class="cb">CB'+esc(c.consecutivo)+'</span></a>';
  }
  // Nota del proyecto (compartida) + nota de este envío. La del envío se marca
  // con su número para que se distinga de la del proyecto.
  function notasHtml(c){
    var s = '';
    if(c.notas)     s += '<div class="cola-nota">📝 '+esc(c.notas)+'</div>';
    if(c.notaEnvio) s += '<div class="cola-nota env">📝 <strong>E'+c.envioIdx+':</strong> '+esc(c.notaEnvio)+'</div>';
    return s;
  }
  // Duración real vs la estimada (solo si se capturó la fecha de inicio).
  // Verde si cumplió lo estimado, ámbar si se pasó.
  function duracionHtml(c){
    if(!c.diasReales || !c.durDias) return '';
    var estim = Math.max(1, Math.ceil(c.durDias - 1e-9));
    var color = c.diasReales > estim ? '#92400E' : '#065F46';
    return ' · <span style="color:'+color+';">'+fmtDias(c.diasReales)+' reales vs '+fmtDias(estim)+' estimados</span>';
  }
  function tamanoUnidad(c){
    if(c.esEnvio){
      if(c.tipoEnvio==='metros') return fmtNum(c.mlTotal,0)+' ML';
      return nUnidades(c.valorEnvio)+' · '+fmtNum(c.mlTotal,0)+' ML';
    }
    return nUnidades(c.cantidad)+' · '+fmtNum(c.mlTotal,0)+' ML';
  }

  function isoAddDays(iso,n){ var p=String(iso).substring(0,10).split('-'); var d=new Date(Date.UTC(+p[0],+p[1]-1,+p[2])); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().substring(0,10); }
  function isoDow(iso){ var p=String(iso).substring(0,10).split('-'); return new Date(Date.UTC(+p[0],+p[1]-1,+p[2])).getUTCDay(); } // 0=Dom
  function todayISO(){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function esLaborable(iso){
    if(_exc[iso]) return _exc[iso].laborable;
    if(isoDow(iso)===0) return false;
    if(_festivos[iso]) return false;
    return true;
  }

  // ── Motor de cronograma en cliente ──
  // Espejo EXACTO de _computarCronograma en Code.gs: agenda de FLUJO CONTINUO.
  // La planta produce `ritmo` ML por día hábil; los proyectos se empacan seguidos
  // sobre un eje de días hábiles y un mismo día puede repartirse entre el final de
  // un proyecto y el inicio del siguiente (no se redondea cada casa a días enteros).
  function nextLaborable(iso){
    var guard=0;
    while(!esLaborable(iso) && guard++<400) iso=isoAddDays(iso,1);
    return iso;
  }
  // Espejo de _pausaAbierta / _ultimoReanude del backend. Un tramo sin `hasta`
  // es la pausa en curso.
  function pausaAbiertaDesde(pausas){
    var ps = pausas || [];
    for(var i=0;i<ps.length;i++) if(ps[i] && ps[i].desde && !ps[i].hasta) return ps[i].desde;
    return '';
  }
  function ultimoReanude(pausas){
    var out = '';
    (pausas||[]).forEach(function(p){ if(p && p.hasta && p.hasta > out) out = p.hasta; });
    return out;
  }
  function computarLocal(items, inicioISO){
    var ritmoG = (_data && _data.config && _data.config.ritmoMlDia) || 300;
    var day0 = nextLaborable(inicioISO);
    var idxCache = [day0];
    function fechaDeIdx(d){
      while(idxCache.length <= d) idxCache.push(nextLaborable(isoAddDays(idxCache[idxCache.length-1],1)));
      return idxCache[d];
    }
    // Índice de día (0-based) de `targetISO` en la misma escala que dayCursor —
    // usado para convertir el ancla "no empezar antes de" a días hábiles.
    function diaIndiceDe(targetISO){
      var target = nextLaborable(targetISO);
      if(target <= day0) return 0;
      var idx=0, cursor=day0, guard=0;
      while(cursor < target && guard++<20000){ cursor = nextLaborable(isoAddDays(cursor,1)); idx++; }
      return idx;
    }
    // Fecha del día hábil nº `n` (1-based) empezando en un día ya hábil.
    function addLaborables(startIso, n){
      var cur = startIso, count = 1, guard = 0;
      while(count < n && guard++ < 4000){ cur = nextLaborable(isoAddDays(cur,1)); count++; }
      return cur;
    }
    var EPS = 1e-9, dayCursor = 0, cola = [];
    items.forEach(function(it, idx){
      var color   = PALETA_GANTT[idx % PALETA_GANTT.length];
      // OJO: resolver siempre desde ritmoOvr (crudo), no desde it.ritmo (ya
      // resuelto en el cálculo anterior) — si no, un cambio de ritmo global no
      // se reflejaría en los proyectos SIN ritmo propio (quedarían pegados).
      var ritmo   = (it.ritmoOvr && it.ritmoOvr > 0) ? it.ritmoOvr : ritmoG;
      // mlTotal ya es el ML de la UNIDAD (mlUnidad para envíos; mlCasa×cantidad
      // para proyecto entero) y es invariante al ritmo → usarlo directo.
      var totalML = (it.mlTotal != null) ? it.mlTotal : (it.mlCasa||0) * (it.cantidad||1);
      // Espejo de _computarCronograma: con avance registrado se agenda solo lo
      // que falta, no la unidad completa.
      var pend    = Math.max(0, totalML - (it.mlAvance||0));
      var durDias = ritmo > 0 ? pend / ritmo : 0;
      var iniCot, finCot, diasSpan, enProd = false;

      if(it.pausada){
        // PAUSADA: barra solo del tramo ya producido, sin proyección futura, y
        // sin tocar dayCursor — es lo que libera el cupo para la priorizada.
        var desdePausa = it.pausadaDesde || pausaAbiertaDesde(it.pausas);
        iniCot = it.fechaRealInicio || desdePausa || '';
        finCot = desdePausa || iniCot;
        if(finCot && iniCot && finCot < iniCot) finCot = iniCot;
        diasSpan = 0; var cp = iniCot, gp = 0;
        while(cp && finCot && cp <= finCot && gp++ < 800){ if(esLaborable(cp)) diasSpan++; cp = isoAddDays(cp,1); }
        if(diasSpan < 1) diasSpan = 1;
        cola.push(Object.assign({}, it, {
          inicio: iniCot, fin: finCot, atrasado: false,
          orden: idx+1, color: color, ritmo: ritmo, enProduccion: false, pausada: true,
          pausadaDesde: desdePausa,
          mlTotal: Math.round(totalML*100)/100,
          mlFalta: Math.round(pend*100)/100,
          durDias: Math.round(durDias*100)/100, dias: diasSpan,
        }));
        return;
      }

      if(it.fechaRealInicio){
        // EN PRODUCCIÓN: anclado a su inicio REAL (aunque sea pasado), no a la cola.
        // Si estuvo pausada y se reanudó, la barra arranca en la última
        // reanudación: representa el tramo que corre ahora, no el histórico.
        enProd = true;
        iniCot = ultimoReanude(it.pausas) || it.fechaRealInicio;
        var diasToca = Math.max(1, Math.ceil(durDias - EPS));
        finCot = addLaborables(nextLaborable(iniCot), diasToca);
        var finIdx = diaIndiceDe(finCot);
        if(finIdx + 1 > dayCursor) dayCursor = finIdx + 1;
        diasSpan = 0; var cur = iniCot, g = 0;
        while(cur <= finCot && g++ < 800){ if(esLaborable(cur)) diasSpan++; cur = isoAddDays(cur,1); }
        if(diasSpan < 1) diasSpan = 1;
      } else {
        if(it.fechaInicioMin){
          var minDay = diaIndiceDe(it.fechaInicioMin);
          if(minDay > dayCursor) dayCursor = minDay;
        }
        var startDay = dayCursor, endDay = dayCursor + durDias;
        dayCursor = endDay;
        var dStart = Math.floor(startDay + EPS);
        var dEnd   = durDias <= EPS ? dStart : Math.floor(endDay - EPS);
        if(dEnd < dStart) dEnd = dStart;
        iniCot = fechaDeIdx(dStart); finCot = fechaDeIdx(dEnd);
        diasSpan = dEnd - dStart + 1;
      }

      cola.push(Object.assign({}, it, {
        inicio: iniCot, fin: finCot,
        atrasado: !!(it.fechaEntrega && finCot && finCot > it.fechaEntrega),
        orden: idx+1, color: color, ritmo: ritmo, enProduccion: enProd, pausada: false,
        mlTotal: Math.round(totalML*100)/100, mlFalta: Math.round(pend*100)/100,
        durDias: Math.round(durDias*100)/100, dias: diasSpan,
      }));
    });
    return { cola: cola };
  }
  // Índice día ISO → [proyectos que tocan ese día]. Un día puede tener varios.
  function indexarDias(){
    _dayItems = {};
    var fuentes = (_data.cola||[]).slice();
    // Los finalizados traen su tramo REAL (inicio/fin capturados en planta).
    // Si no se capturó la fecha de inicio, el backend deja inicio = fin, así que
    // se marca solo el día de término — sin inventar duración.
    if(_verFinalizados) fuentes = fuentes.concat(_data.finalizados||[]);
    fuentes.forEach(function(c){
      if(!c.inicio || !c.fin) return;
      var d = c.inicio, guard=0;
      while(d <= c.fin && guard++<800){
        // Un día no laborable puede tener producción real (se trabajó ese día);
        // por eso finalizados y en-producción no se filtran por calendario laborable.
        if(c.finalizado || c.enProduccion || esLaborable(d)){ (_dayItems[d] = _dayItems[d] || []).push(c); }
        d = isoAddDays(d,1);
      }
    });
  }
  // Recalcula todo a partir de _data.cola (orden/fechas actuales) y re-renderiza
  // al instante, sin ir al servidor.
  function recomputarYRenderizar(){
    if(!_data) return;
    _gen++;   // marca actividad del usuario → invalida cualquier reconciliación en vuelo
    var hoy = todayISO();
    var inicio = (_data.config && _data.config.fechaInicioCola) || hoy;
    if(inicio < hoy) inicio = hoy;   // tope a hoy — espejo del backend, la cola nunca arranca en el pasado
    _data.cola = computarLocal(_data.cola, inicio).cola;
    indexarDias();
    renderCalendario(); renderLeyenda(); renderCola(); renderBacklog(); renderFinalizados();
  }

  // ── Guardado en segundo plano ──
  // Indicador "Guardando… / Guardado ✓" + reconciliación silenciosa con el
  // servidor 1.5s después de que se asienta el último guardado pendiente.
  var _pending = 0;
  var _reconcileTimer = null;
  var _gen = 0;   // se incrementa en cada cambio optimista; invalida reconciliaciones en vuelo
  function beginSave(){
    _pending++;
    var el = document.getElementById('saveStatus');
    if(el){ el.textContent='Guardando…'; el.className='save-status saving'; }
  }
  function endSave(){
    _pending = Math.max(0, _pending-1);
    if(_pending===0){
      var el = document.getElementById('saveStatus');
      if(el){
        el.textContent='Guardado ✓'; el.className='save-status ok';
        setTimeout(function(){ if(_pending===0 && el){ el.textContent=''; el.className='save-status'; } }, 1500);
      }
      scheduleReconcile();
    }
  }
  function scheduleReconcile(){
    if(_reconcileTimer) clearTimeout(_reconcileTimer);
    _reconcileTimer = setTimeout(function(){
      _reconcileTimer = null;
      if(_pending===0) reconciliar();
    }, 1500);
  }
  // Reconciliación silenciosa: descarta la respuesta si el usuario hizo algún
  // cambio (o quedó un guardado pendiente) mientras la petición estaba en curso,
  // para no pisar el estado optimista más reciente.
  function reconciliar(){
    var gen = _gen;
    apiProdColaGet(token).then(function(resp){
      if(_gen !== gen || _pending !== 0) return;  // hubo actividad → ignorar esta foto
      aplicarDatos(resp);
    }).catch(function(){});
  }
  // Agrupa clics repetidos sobre el mismo `key` (misma celda/fila) en una sola
  // llamada al servidor, disparada `delay` ms después del último clic. La UI ya
  // se actualizó al instante (optimista) antes de llamar a esto — esto solo
  // evita mandar una request por cada clic y evita carreras de orden de llegada.
  var _saveTimers = {};
  function debounceSave(key, delay, run){
    if(_saveTimers[key]) clearTimeout(_saveTimers[key]);
    else beginSave();
    _saveTimers[key] = setTimeout(function(){
      delete _saveTimers[key];
      run().finally(endSave);
    }, delay);
  }

  // ── Carga y armado de índices ──
  function aplicarDatos(resp){
    _data = resp;
    _festivos = {}; (resp.festivos||[]).forEach(function(f){ _festivos[f]=true; });
    _exc = {}; (resp.excepciones||[]).forEach(function(e){ _exc[e.fecha]={laborable:e.laborable,nota:e.nota}; });
    // día → proyectos (el backend ya devolvió inicio/fin de cada proyecto)
    indexarDias();
    // config en inputs
    document.getElementById('cfgRitmo').value = resp.config.ritmoMlDia || '';
    document.getElementById('cfgInicio').value = resp.config.fechaInicioCola || '';
    document.getElementById('cfgInicio').min = todayISO();   // la cola nunca arranca en el pasado
    renderRitmoReal();
    // primer render: ir al mes del primer proyecto (o de la fecha de inicio, o hoy)
    if(_mesY===0){
      var ref = (resp.cola&&resp.cola.length&&resp.cola[0].inicio)? resp.cola[0].inicio : (resp.config.fechaInicioCola || todayISO());
      var p=ref.split('-'); _mesY=+p[0]; _mesM=+p[1]-1;
    }
    renderCalendario(); renderLeyenda(); renderCola(); renderBacklog(); renderFinalizados();
  }
  // Carga explícita (inicial / tras guardar config): siempre aplica.
  function cargar(){
    if(_reconcileTimer){ clearTimeout(_reconcileTimer); _reconcileTimer=null; }
    return apiProdColaGet(token).then(aplicarDatos).catch(manejarError);
  }

  // ── Calendario ──
  function renderCalendario(){
    document.getElementById('calTitulo').textContent = MESES[_mesM] + ' ' + _mesY;
    var dow = document.getElementById('calDow');
    dow.innerHTML = DOW.map(function(d){ return '<div class="cal-dow">'+d+'</div>'; }).join('');

    var primeroDow = isoDow(_mesY+'-'+String(_mesM+1).padStart(2,'0')+'-01'); // 0=Dom
    var leadMon = (primeroDow+6)%7; // Lunes-primero
    var diasMes = new Date(Date.UTC(_mesY,_mesM+1,0)).getUTCDate();
    var hoy = todayISO();

    var cells = '';
    for(var i=0;i<leadMon;i++) cells += '<div class="cal-cell empty"></div>';
    for(var dd=1;dd<=diasMes;dd++){
      var iso = _mesY+'-'+String(_mesM+1).padStart(2,'0')+'-'+String(dd).padStart(2,'0');
      var lab = esLaborable(iso);
      var its = _dayItems[iso] || [];
      var cls = 'cal-cell' + (lab?'':' nolab') + (iso===hoy?' hoy':'');
      var inner = '<div class="cal-daynum">'+dd+'</div>';
      if(!lab){
        var nota = _exc[iso]? (_exc[iso].nota||'No laborable') : (_festivos[iso]?'Festivo':(isoDow(iso)===0?'Domingo':'No laborable'));
        inner += '<div class="cal-nolab-tag">'+esc(nota)+'</div>';
      }
      // Los ítems se pintan también en días no laborables: un finalizado pudo
      // haberse producido en un día que hoy está marcado como no laborable.
      for(var qi=0; qi<its.length && qi<3; qi++){
        var it2 = its[qi];
        var tip = it2.finalizado
          ? 'Finalizado — producción real '+fechaCorta(it2.inicio)+' → '+fechaCorta(it2.fin)
          : it2.enProduccion
            ? 'En producción — inició '+fechaCorta(it2.fechaRealInicio)+', fin estimado '+fechaCorta(it2.fin)
            : etiquetaUnidad(it2)+' — planeado '+fechaCorta(it2.inicio)+' → '+fechaCorta(it2.fin);
        var extraCls = it2.finalizado ? ' fin' : (it2.enProduccion ? ' prod' : '');
        var prefijo  = it2.finalizado ? '✓ ' : (it2.enProduccion ? '▶ ' : '');
        inner += '<div class="cal-casa'+extraCls+'" style="background:'+it2.color+';" title="'+esc(tip)+'">'+
                 prefijo+esc(it2.proyecto||'')+
                 (it2.cantidad>1?' <small>×'+it2.cantidad+'</small>':'')+'</div>';
      }
      if(its.length>3) inner += '<div class="cal-nolab-tag">+'+(its.length-3)+' más</div>';
      cells += '<div class="'+cls+'" data-dia="'+iso+'">'+inner+'</div>';
    }
    var body = document.getElementById('calBody');
    body.innerHTML = cells;
    body.querySelectorAll('.cal-cell[data-dia]').forEach(function(c){
      c.addEventListener('click', function(){ toggleDia(c.getAttribute('data-dia')); });
    });
  }

  function renderLeyenda(){
    var cont = document.getElementById('calLeyenda');
    if(!_data.cola || !_data.cola.length){ cont.innerHTML=''; return; }
    cont.innerHTML = _data.cola.map(function(c){
      return '<div class="leg-item"><span class="leg-dot" style="background:'+c.color+';"></span>'+esc(etiquetaUnidad(c))+'</div>';
    }).join('');
  }

  // ── Cola de producción ──
  function renderCola(){
    var body = document.getElementById('colaBody');
    var cola = _data.cola || [];
    // Carga de trabajo pendiente en la cola (ML y días estimados de producción).
    var totML = cola.reduce(function(s,c){ return s + (Number(c.mlTotal)||0); }, 0);
    var totDias = cola.reduce(function(s,c){ return s + (Number(c.durDias)||0); }, 0);
    document.getElementById('colaResumen').textContent = cola.length
      ? '· '+cola.length+(cola.length===1?' proyecto':' proyectos')+' · '+fmtNum(totML,0)+' ML · ≈'+fmtDias(Math.round(totDias*10)/10)
      : '';
    if(!cola.length){
      body.innerHTML = '<div style="text-align:center;padding:20px;color:var(--cf-gray-text);font-size:0.85rem;">No hay cotizaciones aprobadas. Aprueba cotizaciones para armar la cola.</div>';
      return;
    }
    body.innerHTML = cola.map(function(c,i){
      var atraso = c.atrasado ? '<span class="cola-atraso">Atrasado</span>' :
                   (c.fechaEntrega ? '<span class="cola-ok">A tiempo</span>' : '');
      var rango = fechaCorta(c.inicio)+' → '+fechaCorta(c.fin);
      return '<div class="cola-row" data-uid="'+esc(c.uid)+'">'+
        '<div class="cola-orden">'+
          '<input type="number" class="orden-input" data-orden="'+i+'" min="1" max="'+cola.length+'" '+
                 'value="'+(i+1)+'" title="Escribe el puesto al que quieres mover este proyecto y presiona Enter">'+
          '<span class="cola-drag-handle" draggable="true" data-uid="'+esc(c.uid)+'" title="Arrastrar para reordenar">⠿</span>'+
        '</div>'+
        '<div class="cola-color" style="background:'+c.color+';"></div>'+
        '<div class="cola-main">'+
          '<div class="cola-nombre">'+nombreProyectoHtml(c)+envioBadge(c)+
            (c.pausada
              ? '<span class="pausa-badge" title="Pausada el '+esc(fechaCorta(c.pausadaDesde))+' — no consume días de la cola">⏸ Pausada</span>'
              : (c.fechaRealInicio?'<span class="prod-badge" title="Producción iniciada el '+esc(fechaCorta(c.fechaRealInicio))+'">▶ En producción</span>':''))+'</div>'+
          '<div class="cola-meta">'+tamanoUnidad(c)+' · '+
            // Con avance registrado, lo que importa es lo que FALTA: es lo que se
            // va a agendar cuando se reanude.
            (c.mlAvance > 0 ? 'faltan '+fmtNum(c.mlFalta,0)+' ML · ≈'+fmtDias(c.durDias)
                            : '≈'+fmtDias(c.durDias))+
            (c.vinculadas?' · 🔗'+c.vinculadas:'')+metaAjustes(c)+
            (c.fechaRealInicio?' · inició '+fechaCorta(c.fechaRealInicio):'')+
            (c.pausada?' · pausada desde '+fechaCorta(c.pausadaDesde):'')+'</div>'+
          notasHtml(c)+
          '<div class="cola-fechas">'+rango+'</div>'+
        '</div>'+
        '<div class="cola-entrega">'+
          '<span style="font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;color:var(--cf-gray-text);">Entrega</span>'+
          '<input type="date" value="'+esc(c.fechaEntrega)+'" data-entrega="'+esc(c.uid)+'" title="Fecha comprometida con el cliente">'+
          atraso+
        '</div>'+
        rowMenu(
          '<a class="menu-link" href="proyecto.html?cb='+encodeURIComponent(c.consecutivo)+'" target="_blank" rel="noopener">📋 Hoja de vida</a>'+
          '<button data-nota="'+esc(c.uid)+'" data-nombre="'+esc(etiquetaUnidad(c))+'">📝 '+((c.notas||c.notaEnvio)?'Editar nota':'Agregar nota')+'</button>'+
          '<button data-iniciar="'+esc(c.uid)+'" data-nombre="'+esc(etiquetaUnidad(c))+'">▶ '+(c.fechaRealInicio?'Editar inicio real':'Iniciar producción')+'</button>'+
          // Pausar / reanudar. Solo tiene sentido sobre algo que ya arrancó: lo
          // que no arrancó se saca de la cola, que es otra operación.
          (c.pausada
            ? '<button data-reanudar="'+esc(c.uid)+'" data-nombre="'+esc(etiquetaUnidad(c))+'">▶ Reanudar producción</button>'
            : (c.fechaRealInicio
                ? '<button data-pausar="'+esc(c.uid)+'" data-nombre="'+esc(etiquetaUnidad(c))+'">⏸ Pausar producción</button>'
                : ''))+
          '<button data-partir="'+esc(c.archivo)+'">✂ Partir en envíos</button>'+
          // Partir ESTE envío, no el proyecto entero. Solo si es un envío y no
          // arrancó: con producción encima habría que decidir a cuál parte
          // pertenece lo ya fabricado, y eso no se puede adivinar.
          ((c.esEnvio && !c.fechaRealInicio)
            ? '<button data-partir-envio="'+esc(c.uid)+'">✂ Partir este envío en partes</button>' : '')+
          '<button data-ajustes="'+esc(c.uid)+'" data-nombre="'+esc(etiquetaUnidad(c))+'">⚙ Ritmo / fecha de inicio</button>'+
          '<div class="menu-sep"></div>'+
          '<button data-sacar="'+esc(c.uid)+'">Sacar de la cola</button>'+
          '<button class="danger" data-finalizar="'+esc(c.uid)+'" data-nombre="'+esc(etiquetaUnidad(c))+'">Finalizar</button>'
        )+
      '</div>';
    }).join('');

    // Reordenar escribiendo el puesto. En 'change' (Enter o al salir del campo),
    // no en cada tecla: si no, escribir "12" reordenaría primero al puesto 1.
    body.querySelectorAll('.orden-input').forEach(function(inp){
      inp.addEventListener('change', function(){
        reordenarUnidad(parseInt(inp.getAttribute('data-orden'), 10), inp.value);
      });
      inp.addEventListener('keydown', function(e){ if(e.key==='Enter') inp.blur(); });
    });
    body.querySelectorAll('[data-entrega]').forEach(function(inp){
      inp.addEventListener('change', function(){ cambiarEntrega(inp.getAttribute('data-entrega'), inp.value); });
    });
    body.querySelectorAll('[data-sacar]').forEach(function(b){
      b.addEventListener('click', function(){ sacarDeCola(b.getAttribute('data-sacar')); });
    });
    body.querySelectorAll('[data-finalizar]').forEach(function(b){
      b.addEventListener('click', function(){ abrirFinalizar(b.getAttribute('data-finalizar'), b.getAttribute('data-nombre')); });
    });
    body.querySelectorAll('[data-ajustes]').forEach(function(b){
      b.addEventListener('click', function(){ abrirAjustes(b.getAttribute('data-ajustes'), b.getAttribute('data-nombre')); });
    });
    body.querySelectorAll('[data-partir]').forEach(function(b){
      b.addEventListener('click', function(){ abrirEnvios(b.getAttribute('data-partir')); });
    });
    body.querySelectorAll('[data-partir-envio]').forEach(function(b){
      b.addEventListener('click', function(){ abrirPartir(b.getAttribute('data-partir-envio')); });
    });
    body.querySelectorAll('[data-pausar]').forEach(function(b){
      b.addEventListener('click', function(){ abrirPausar(b.getAttribute('data-pausar'), b.getAttribute('data-nombre')); });
    });
    body.querySelectorAll('[data-reanudar]').forEach(function(b){
      b.addEventListener('click', function(){ reanudarUnidad(b.getAttribute('data-reanudar'), b.getAttribute('data-nombre')); });
    });
    body.querySelectorAll('[data-iniciar]').forEach(function(b){
      b.addEventListener('click', function(){ abrirIniciar(b.getAttribute('data-iniciar'), b.getAttribute('data-nombre')); });
    });
    body.querySelectorAll('[data-nota]').forEach(function(b){
      b.addEventListener('click', function(){ abrirNota(b.getAttribute('data-nota'), b.getAttribute('data-nombre')); });
    });
    bindRowMenus(body);
    bindDragDrop(body);
  }

  // ── Backlog: aprobados sin cola ──
  function renderBacklog(){
    var card = document.getElementById('backlogCard');
    var body = document.getElementById('backlogBody');
    var bl = (_data && _data.backlog) || [];
    if(!bl.length){ card.style.display='none'; body.innerHTML=''; return; }
    card.style.display='';
    var blML = bl.reduce(function(s,c){ return s + (Number(c.mlTotal)||0); }, 0);
    document.getElementById('backlogResumen').textContent =
      '· '+bl.length+(bl.length===1?' proyecto':' proyectos')+' · '+fmtNum(blML,0)+' ML';
    body.innerHTML = bl.map(function(c){
      return '<div class="cola-row" data-uid="'+esc(c.uid)+'">'+
        '<div class="cola-color" style="background:var(--cf-gray-mid);"></div>'+
        '<div class="cola-main">'+
          '<div class="cola-nombre">'+nombreProyectoHtml(c)+envioBadge(c)+'</div>'+
          '<div class="cola-meta">'+tamanoUnidad(c)+' · ≈'+fmtDias(c.durDias)+(c.vinculadas?' · 🔗'+c.vinculadas:'')+metaAjustes(c)+'</div>'+
          notasHtml(c)+
        '</div>'+
        '<button class="cola-toggle-btn add" data-agregar="'+esc(c.uid)+'" title="Agregar al Gantt (se programa al final de la cola)">+ Agregar a la cola</button>'+
        rowMenu(
          '<a class="menu-link" href="proyecto.html?cb='+encodeURIComponent(c.consecutivo)+'" target="_blank" rel="noopener">📋 Hoja de vida</a>'+
          '<button data-nota="'+esc(c.uid)+'" data-nombre="'+esc(etiquetaUnidad(c))+'">📝 '+((c.notas||c.notaEnvio)?'Editar nota':'Agregar nota')+'</button>'+
          '<button data-partir="'+esc(c.archivo)+'">✂ Partir en envíos</button>'+
          // Partir ESTE envío, no el proyecto entero. Solo si es un envío y no
          // arrancó: con producción encima habría que decidir a cuál parte
          // pertenece lo ya fabricado, y eso no se puede adivinar.
          ((c.esEnvio && !c.fechaRealInicio)
            ? '<button data-partir-envio="'+esc(c.uid)+'">✂ Partir este envío en partes</button>' : '')+
          '<button data-ajustes="'+esc(c.uid)+'" data-nombre="'+esc(etiquetaUnidad(c))+'">⚙ Ritmo / fecha de inicio</button>'+
          '<div class="menu-sep"></div>'+
          '<button class="danger" data-finalizar="'+esc(c.uid)+'" data-nombre="'+esc(etiquetaUnidad(c))+'">Finalizar</button>'
        )+
      '</div>';
    }).join('');
    body.querySelectorAll('[data-agregar]').forEach(function(b){
      b.addEventListener('click', function(){ agregarACola(b.getAttribute('data-agregar')); });
    });
    body.querySelectorAll('[data-finalizar]').forEach(function(b){
      b.addEventListener('click', function(){ abrirFinalizar(b.getAttribute('data-finalizar'), b.getAttribute('data-nombre')); });
    });
    body.querySelectorAll('[data-ajustes]').forEach(function(b){
      b.addEventListener('click', function(){ abrirAjustes(b.getAttribute('data-ajustes'), b.getAttribute('data-nombre')); });
    });
    body.querySelectorAll('[data-partir]').forEach(function(b){
      b.addEventListener('click', function(){ abrirEnvios(b.getAttribute('data-partir')); });
    });
    body.querySelectorAll('[data-partir-envio]').forEach(function(b){
      b.addEventListener('click', function(){ abrirPartir(b.getAttribute('data-partir-envio')); });
    });
    body.querySelectorAll('[data-pausar]').forEach(function(b){
      b.addEventListener('click', function(){ abrirPausar(b.getAttribute('data-pausar'), b.getAttribute('data-nombre')); });
    });
    body.querySelectorAll('[data-reanudar]').forEach(function(b){
      b.addEventListener('click', function(){ reanudarUnidad(b.getAttribute('data-reanudar'), b.getAttribute('data-nombre')); });
    });
    body.querySelectorAll('[data-nota]').forEach(function(b){
      b.addEventListener('click', function(){ abrirNota(b.getAttribute('data-nota'), b.getAttribute('data-nombre')); });
    });
    bindRowMenus(body);
  }

  // ── Finalizados: historial (planeado vs real) ──
  function renderFinalizados(){
    var card = document.getElementById('finalizadosCard');
    var body = document.getElementById('finalizadosBody');
    var fl = (_data && _data.finalizados) || [];
    if(!fl.length){ card.style.display='none'; body.innerHTML=''; return; }
    card.style.display='';
    body.innerHTML = fl.map(function(c){
      var badge = c.atrasado ? '<span class="cola-atraso">Atrasado</span>' : (c.fechaEntrega ? '<span class="cola-ok">A tiempo</span>' : '');
      return '<div class="cola-row">'+
        '<div class="cola-main">'+
          '<div class="cola-nombre">'+nombreProyectoHtml(c)+envioBadge(c)+'</div>'+
          '<div class="cola-meta">'+tamanoUnidad(c)+(c.vinculadas?' · 🔗'+c.vinculadas:'')+'</div>'+
          '<div class="cola-fechas">Entrega: '+(c.fechaEntrega?fechaCorta(c.fechaEntrega):'—')+' · Real: '+
            (c.fechaRealInicio ? fechaCorta(c.fechaRealInicio)+' → '+fechaCorta(c.fechaReal) : fechaCorta(c.fechaReal))+
            duracionHtml(c)+'</div>'+
        '</div>'+
        badge+
        '<button class="cola-toggle-btn" data-reabrir="'+esc(c.uid)+'" title="Deshacer — vuelve a Aprobados sin cola">Reabrir</button>'+
      '</div>';
    }).join('');
    body.querySelectorAll('[data-reabrir]').forEach(function(b){
      b.addEventListener('click', function(){ reabrirProyecto(b.getAttribute('data-reabrir')); });
    });
  }

  // ── Alertas de higiene (huecos cotizar→programar→producir) ──
  // Solo lectura, sin acciones optimistas: se pide una vez al iniciar y con el
  // botón "Revisar" — no está atada al ciclo de reconciliación de la cola.
  function cargarHigiene(){
    apiProdAlertasHigiene(token).then(renderHigiene).catch(function(e){
      if(e && e.tipo==='auth') manejarError(e);   // solo interrumpe si la sesión venció
    });
  }
  function renderHigiene(resp){
    var card = document.getElementById('higieneCard');
    var sc = resp.iniciadasSinCarpeta || [], sq = resp.sinCotizacion || [];
    if(!sc.length && !sq.length){ card.style.display='none'; return; }
    card.style.display='';
    // El panel viene minimizado: el contador en el título avisa que hay algo dentro.
    var n = sc.length + sq.length;
    document.getElementById('higieneResumen').textContent = '('+n+(n===1?' pendiente)':' pendientes)');

    // Antes esto listaba TODA cotización aprobada sin carpeta, incluidas las
    // programadas para dentro de dos meses — que es lo normal, porque la carpeta
    // se arma cuando se va a producir. Ahora lista solo lo que de verdad es un
    // hueco: producción ya arrancada sin carpeta a la cual atribuirla.
    document.getElementById('higieneSinCarpeta').innerHTML = !sc.length ? '' :
      '<div class="higiene-titulo">Producción iniciada sin carpeta vinculada ('+sc.length+')</div>' +
      sc.map(function(x){
        var sug = (x.sugerencias||[]).length
          ? ' · <span style="color:#0E7490;">'+(x.sugerencias.length===1?'hay 1 carpeta que coincide':'hay '+x.sugerencias.length+' carpetas que coinciden')+'</span>'
          : '';
        return '<div class="cola-row"><div class="cola-main">'+
          '<div class="cola-nombre">'+esc(x.proyecto)+' <span style="font-weight:400;color:var(--cf-gray-text);font-size:0.72rem;">CB'+esc(x.consecutivo)+'</span></div>'+
          '<div class="cola-meta">produciendo desde '+fechaCorta(x.fechaRealInicio)+' · '+fmtNum(x.mlTotal,0)+' ML'+
            (x.totalUnidades>1 ? ' ('+x.unidades+' de '+x.totalUnidades+' envíos)' : '')+
            (x.finalizadas ? ' · '+x.finalizadas+' ya finalizado(s)' : '')+ sug +'</div>'+
        '</div>'+
        '<a class="cola-toggle-btn" href="cotizaciones.html?archivo='+encodeURIComponent(x.archivo)+'" target="_blank" rel="noopener" title="Abrir esta cotización para vincular su carpeta de producción">Vincular →</a>'+
        '</div>';
      }).join('');

    document.getElementById('higieneSinCotizacion').innerHTML = !sq.length ? '' :
      '<div class="higiene-titulo">Carpetas en producción sin cotización vinculada ('+sq.length+')</div>' +
      sq.map(function(x){
        return '<div class="cola-row"><div class="cola-main">'+
          '<div class="cola-nombre">'+esc(x.nombre)+'</div>'+
          '<div class="cola-meta">'+fechaCorta(x.fecha)+' · '+fmtNum(x.metrosTotal,0)+' ML</div>'+
        '</div>'+
        '<a class="cola-toggle-btn" href="https://drive.google.com/drive/folders/'+esc(x.carpetaId)+'" target="_blank" rel="noopener">Ver en Drive</a>'+
        '</div>';
      }).join('');
  }

  // ── Nota del proyecto (nombre legible sin tocar los archivos base) ──
  var _notaUid = null;
  function abrirNota(uid, nombre){
    cerrarMenus();
    _notaUid = uid;
    var item = buscarItem(uid);
    var esEnvio = !!(item && item.esEnvio);
    document.getElementById('notaProyectoNombre').textContent = nombre || '';
    document.getElementById('notaTexto').value = (item && item.notas) || '';
    // El campo de envío solo aparece si la unidad ES un envío.
    document.getElementById('notaEnvioWrap').style.display = esEnvio ? '' : 'none';
    document.getElementById('notaAlcanceProy').textContent = esEnvio ? '(se ve en todos sus envíos)' : '';
    if(esEnvio){
      document.getElementById('notaEnvioLabel').textContent = 'envío '+item.envioIdx+'/'+item.enviosTotal;
      document.getElementById('notaEnvioTexto').value = item.notaEnvio || '';
    }
    document.getElementById('modalNota').classList.remove('hidden');
    setTimeout(function(){ document.getElementById(esEnvio ? 'notaEnvioTexto' : 'notaTexto').focus(); }, 0);
  }
  function cerrarNota(){
    document.getElementById('modalNota').classList.add('hidden');
    _notaUid = null;
  }
  function guardarNota(){
    var uid = _notaUid;
    if(!uid) return;
    var item = buscarItem(uid);
    var esEnvio = !!(item && item.esEnvio);
    var nota = document.getElementById('notaTexto').value.trim();
    var notaEnvio = esEnvio ? document.getElementById('notaEnvioTexto').value.trim() : undefined;
    cerrarNota();
    aplicarNota(uid, nota, notaEnvio);
  }
  // La nota es del PROYECTO (archivo): al cambiarla se refleja en todas sus
  // unidades hermanas (mismos archivos = mismo proyecto, ej. sus envíos).
  function _setNotaArchivo(archivo, nota){
    // La nota es por proyecto (archivo): aplicarla a todas sus unidades donde estén.
    _data.cola.concat(_data.backlog||[], _data.finalizados||[]).forEach(function(c){ if(c.archivo===archivo) c.notas = nota; });
  }
  function _setNotaEnvio(uid, nota){
    _data.cola.concat(_data.backlog||[], _data.finalizados||[]).forEach(function(c){ if(c.uid===uid) c.notaEnvio = nota; });
  }
  function aplicarNota(uid, nota, notaEnvio){
    var item = buscarItem(uid);
    if(!item) return;
    var archivo = item.archivo;
    var beforeProy  = item.notas || '';
    var beforeEnvio = item.notaEnvio || '';
    _setNotaArchivo(archivo, nota);
    if(notaEnvio !== undefined) _setNotaEnvio(uid, notaEnvio);
    recomputarYRenderizar();
    beginSave();
    apiProdColaNota(token, uid, nota, notaEnvio).then(function(){
      toast('Nota guardada','ok');
    }).catch(function(e){
      // Revertir por archivo/uid (no por referencia): el motor recrea los objetos.
      _setNotaArchivo(archivo, beforeProy);
      if(notaEnvio !== undefined) _setNotaEnvio(uid, beforeEnvio);
      recomputarYRenderizar();
      manejarError(e);
    }).finally(endSave);
  }

  // ── Iniciar producción: captura la fecha REAL de arranque ──
  var _iniciarUid = null;
  function abrirIniciar(uid, nombre){
    cerrarMenus();
    _iniciarUid = uid;
    var item = buscarItem(uid);
    var hoy = todayISO();
    document.getElementById('iniProyectoNombre').textContent = nombre || '';
    document.getElementById('iniFecha').value = (item && item.fechaRealInicio) || hoy;
    document.getElementById('iniFecha').max = hoy;   // no se puede iniciar en el futuro
    document.getElementById('iniQuitar').style.display = (item && item.fechaRealInicio) ? '' : 'none';
    document.getElementById('modalIniciar').classList.remove('hidden');
  }
  function cerrarIniciar(){
    document.getElementById('modalIniciar').classList.add('hidden');
    _iniciarUid = null;
  }
  function confirmarIniciar(){
    var uid = _iniciarUid, fecha = document.getElementById('iniFecha').value;
    if(!uid || !fecha) return;
    cerrarIniciar();
    marcarInicio(uid, fecha);
  }
  function quitarInicio(){
    var uid = _iniciarUid;
    if(!uid) return;
    cerrarIniciar();
    marcarInicio(uid, '');
  }
  function marcarInicio(uid, fecha){
    var item = buscarItem(uid);
    if(!item) return;
    var before = item.fechaRealInicio || '';
    item.fechaRealInicio = fecha;
    recomputarYRenderizar();
    beginSave();
    apiProdColaIniciar(token, uid, fecha).then(function(){
      toast(fecha ? 'Inicio de producción registrado' : 'Marca de inicio quitada','ok');
    }).catch(function(e){
      var it = buscarItem(uid);
      if(it) it.fechaRealInicio = before;
      recomputarYRenderizar();
      // Falta la carpeta de producción: en vez de dejar el error y que la
      // persona salga a buscarla, se abre la conciliación aquí mismo con las
      // carpetas cuyo nombre coincide con el código de la cotización.
      if(e && e.datos && e.datos.faltaCarpeta){
        abrirConciliarCarpeta(uid, fecha, e.datos);
        return;
      }
      manejarError(e);
    }).finally(endSave);
  }

  // ── Finalizar unidad (modal con fechas reales, luego optimista) ──
  var _finalizarUid = null;
  function abrirFinalizar(uid, nombre){
    cerrarMenus();
    _finalizarUid = uid;
    var item = buscarItem(uid);
    var hoy = todayISO();
    document.getElementById('finProyectoNombre').textContent = nombre || '';
    document.getElementById('finFecha').value = hoy;
    document.getElementById('finFecha').max = hoy;
    // Si ya se marcó "Iniciar producción", viene precargada; si no, queda vacía
    // para rellenarla ahora (es opcional: sin ella se marca solo el día de fin).
    var ini = (item && item.fechaRealInicio) || '';
    document.getElementById('finFechaInicio').value = ini;
    document.getElementById('finFechaInicio').max = hoy;
    document.getElementById('finInicioHint').textContent = ini
      ? 'Capturada al marcar "Iniciar producción". Puedes corregirla.'
      : 'Opcional. Sin ella, en el calendario se marca solo el día de finalización.';
    document.getElementById('modalFinalizar').classList.remove('hidden');
  }
  function cerrarFinalizar(){
    document.getElementById('modalFinalizar').classList.add('hidden');
    _finalizarUid = null;
  }
  function confirmarFinalizar(){
    var uid = _finalizarUid;
    var fecha = document.getElementById('finFecha').value;
    var fechaIni = document.getElementById('finFechaInicio').value;
    if(!uid || !fecha) return;
    if(fechaIni && fechaIni > fecha){ toast('La fecha de inicio no puede ser posterior a la de finalización','error'); return; }
    cerrarFinalizar();
    finalizarProyecto(uid, fecha, fechaIni);
  }
  function finalizarProyecto(uid, fechaReal, fechaRealInicio){
    var fromCola = _data.cola.map(function(c){return c.uid;}).indexOf(uid);
    var fromBacklog = fromCola<0 ? (_data.backlog||[]).map(function(c){return c.uid;}).indexOf(uid) : -1;
    var item = fromCola>=0 ? _data.cola[fromCola] : (fromBacklog>=0 ? _data.backlog[fromBacklog] : null);
    if(!item) return;
    if(fromCola>=0) _data.cola.splice(fromCola,1);
    else if(fromBacklog>=0) _data.backlog.splice(fromBacklog,1);

    // Conserva TODOS los campos del ítem original (mlTotal, ritmo, esEnvio…) para
    // que, si se reabre, vuelva al backlog completo sin datos faltantes.
    var iniReal = fechaRealInicio || item.fechaRealInicio || '';
    var registro = Object.assign({}, item, {
      fechaReal: fechaReal,
      fechaRealInicio: iniReal,
      atrasado: !!(item.fechaEntrega && fechaReal > item.fechaEntrega),
      // Espejo del backend: tramo real para el calendario (sin inicio → solo el día de fin)
      inicio: (iniReal && iniReal <= fechaReal) ? iniReal : fechaReal,
      fin: fechaReal,
      finalizado: true,
      color: '#64748B',
    });
    _data.finalizados = _data.finalizados || [];
    _data.finalizados.unshift(registro);
    recomputarYRenderizar();

    beginSave();
    apiProdColaFinalizar(token, uid, fechaReal, fechaRealInicio || '').then(function(res){
      // La carpeta de producción en Drive se cierra sola cuando termina TODO lo
      // que la usa. Si no se cerró, se dice por qué: sin esto uno va a la página
      // de producción, la ve abierta, y no sabe si el sistema falló o si de
      // verdad falta trabajo de otra cotización (PLAN_ESTADOS §5).
      var cerradas = (res && res.carpetasCerradas) || [];
      var bloq     = (res && res.carpetasBloqueadas) || [];
      if(cerradas.length){
        toast('Finalizado · carpeta de producción cerrada','ok');
      } else if(bloq.length){
        var falta = [];
        bloq.forEach(function(b){
          (b.porque||[]).forEach(function(a){ if(falta.indexOf(a)<0) falta.push(a); });
        });
        toast('Finalizado. La carpeta sigue abierta: falta '+falta.join(', '),'ok');
      } else {
        toast('Finalizado','ok');
      }
    }).catch(function(e){
      var fi = _data.finalizados.map(function(x){return x.uid;}).indexOf(uid);
      if(fi>=0) _data.finalizados.splice(fi,1);
      if(fromCola>=0) _data.cola.splice(fromCola,0,item);
      else if(fromBacklog>=0) _data.backlog.splice(fromBacklog,0,item);
      recomputarYRenderizar();
      manejarError(e);
    }).finally(endSave);
  }

  // Deshacer un "Finalizar" por accidente: vuelve a Aprobados sin cola (backlog).
  function reabrirProyecto(uid){
    var idx = (_data.finalizados||[]).map(function(c){return c.uid;}).indexOf(uid);
    if(idx<0) return;
    var item = _data.finalizados[idx];
    _data.finalizados.splice(idx,1);
    _data.backlog = _data.backlog || [];
    _data.backlog.push(item);
    recomputarYRenderizar();

    beginSave();
    apiProdColaReabrir(token, uid).then(function(){
      toast('Reabierto (queda aprobado sin cola)','ok');
    }).catch(function(e){
      var b = _data.backlog.map(function(x){return x.uid;}).indexOf(uid);
      if(b>=0) _data.backlog.splice(b,1);
      _data.finalizados.splice(idx,0,item);
      recomputarYRenderizar();
      manejarError(e);
    }).finally(endSave);
  }

  // ── Ajustes de unidad: ritmo propio (por proyecto) + fecha mínima (por unidad) ──
  var _ajustesUid = null;
  function buscarItem(uid){
    return _data.cola.filter(function(c){return c.uid===uid;})[0] ||
           (_data.backlog||[]).filter(function(c){return c.uid===uid;})[0] || null;
  }
  function abrirAjustes(uid, nombre){
    cerrarMenus();
    _ajustesUid = uid;
    var item = buscarItem(uid);
    var ritmoG = (_data.config && _data.config.ritmoMlDia) || 300;
    document.getElementById('ajProyectoNombre').textContent = nombre || '';
    document.getElementById('ajRitmo').value = (item && item.ritmoOvr) ? item.ritmoOvr : '';
    document.getElementById('ajRitmo').placeholder = 'Usar el global ('+fmtNum(ritmoG,0)+' ML/d)';
    document.getElementById('ajFechaMin').value = (item && item.fechaInicioMin) ? item.fechaInicioMin : '';
    document.getElementById('modalAjustes').classList.remove('hidden');
  }
  function cerrarAjustes(){
    document.getElementById('modalAjustes').classList.add('hidden');
    _ajustesUid = null;
  }
  function guardarAjustes(){
    var uid = _ajustesUid;
    if(!uid) return;
    var ritmoStr = document.getElementById('ajRitmo').value;
    var fechaMin = document.getElementById('ajFechaMin').value;
    if(ritmoStr && !(Number(ritmoStr) > 0)){ toast('El ritmo debe ser mayor a 0','error'); return; }
    cerrarAjustes();
    aplicarAjustes(uid, ritmoStr ? Number(ritmoStr) : null, fechaMin || '');
  }
  function limpiarAjustesModal(){
    var uid = _ajustesUid;
    if(!uid) return;
    cerrarAjustes();
    aplicarAjustes(uid, null, '');
  }
  // Recalcula durDias con el ritmo dado — para ítems del backlog, que NO pasan
  // por computarLocal. mlTotal (mlUnidad) es invariante al ritmo → no se toca.
  function _recalcMetricas(item, ritmoEfectivo){
    var totalML = (item.mlTotal != null) ? item.mlTotal : (item.mlCasa||0) * (item.cantidad||1);
    item.durDias = ritmoEfectivo>0 ? Math.round(totalML/ritmoEfectivo*100)/100 : 0;
  }
  // El ritmo es por PROYECTO (afecta a todos los envíos): al aplicarlo, se
  // actualiza el ritmoOvr de TODAS las unidades con el mismo archivo. El ancla
  // (fechaInicioMin) es solo de la unidad tocada.
  function aplicarAjustes(uid, ritmoOvr, fechaInicioMin){
    var item = buscarItem(uid);
    if(!item) return;
    var ritmoG = (_data.config && _data.config.ritmoMlDia) || 300;
    var ritmoEfectivo = (ritmoOvr && ritmoOvr>0) ? ritmoOvr : ritmoG;
    var archivo = item.archivo;
    // snapshot para revertir
    var hermanos = _data.cola.concat(_data.backlog||[]).filter(function(c){return c.archivo===archivo;});
    var before = hermanos.map(function(c){ return { c:c, ritmoOvr:c.ritmoOvr||null, ritmo:c.ritmo, durDias:c.durDias }; });
    var beforeFecha = { fechaInicioMin: item.fechaInicioMin||'' };

    hermanos.forEach(function(c){ c.ritmoOvr = ritmoOvr; c.ritmo = ritmoEfectivo; _recalcMetricas(c, ritmoEfectivo); });
    item.fechaInicioMin = fechaInicioMin || '';
    recomputarYRenderizar();

    beginSave();
    apiProdColaAjustesSet(token, uid, ritmoOvr || '', fechaInicioMin || '').then(function(){
      toast('Ajustes guardados','ok');
    }).catch(function(e){
      before.forEach(function(s){ s.c.ritmoOvr = s.ritmoOvr; s.c.ritmo = s.ritmo; s.c.durDias = s.durDias; });
      item.fechaInicioMin = beforeFecha.fechaInicioMin;
      recomputarYRenderizar();
      manejarError(e);
    }).finally(endSave);
  }

  // ── Partir en envíos (modal, NO optimista: recarga tras guardar) ──
  var _enviosArchivo = null, _enviosProy = null, _enviosRows = [];
  function _soloMetros(){ return !!(_enviosProy && _enviosProy.cantidad === 1); }  // 1 unidad → solo por metros
  function _mlDeRow(r){ var v = parseFloat(r.valor) || 0; return r.tipo === 'metros' ? v : v * (_enviosProy.mlCasa || 0); }
  function abrirEnvios(archivo){
    cerrarMenus();
    var unidades = _data.cola.concat(_data.backlog||[], _data.finalizados||[]).filter(function(c){ return c.archivo===archivo; });
    if(!unidades.length){ toast('No se encontró el proyecto','error'); return; }
    var any = unidades[0];
    _enviosArchivo = archivo;
    _enviosProy = { cantidad: any.cantidad, mlCasa: any.mlCasa, totalML: Math.round((any.mlCasa||0)*(any.cantidad||1)*100)/100, proyecto: any.proyecto };
    var envs = unidades.filter(function(c){ return c.esEnvio; }).sort(function(a,b){ return a.envioIdx-b.envioIdx; });
    // Un envío ya producido (cerrado o arrancado) tiene el tamaño congelado: el
    // backend lo rechaza y aquí se pinta en solo lectura, para que el freno se
    // vea antes de intentarlo. `finalizado` lo marca el cronograma en la lista de
    // finalizados; `fechaRealInicio` viene en toda unidad que ya arrancó.
    _enviosRows = envs.map(function(c){
      return { id:c.envioId, tipo:c.tipoEnvio, valor:c.valorEnvio, fechaEntrega:c.fechaEntrega||'',
               congelado: !!(c.finalizado || c.fechaRealInicio),
               motivo: c.finalizado ? 'Finalizado' : (c.fechaRealInicio ? 'En producción' : '') };
    });
    if(!_enviosRows.length){
      _enviosRows = [_soloMetros()
        ? { id:null, tipo:'metros', valor:'', fechaEntrega:'' }
        : { id:null, tipo:'unidades', valor:Math.ceil(_enviosProy.cantidad/2), fechaEntrega:'' }];
    }
    var hayCongelado = _enviosRows.some(function(r){ return r.congelado; });
    document.getElementById('envProyectoNombre').textContent = _enviosProy.proyecto || '';
    document.getElementById('envTotalInfo').textContent = 'Total del proyecto: '+nUnidades(_enviosProy.cantidad)+' · '+fmtNum(_enviosProy.totalML,0)+' ML'+
      (_soloMetros() ? ' — proyecto de 1 unidad: solo se puede partir por metros' : '')+
      (hayCongelado ? ' — hay envíos ya producidos: su tamaño no se puede cambiar' : '');
    // Etiqueta de "partir en N partes": por unidades o por metros según el proyecto
    document.getElementById('envPartesUnidad').textContent = _soloMetros() ? 'partes iguales (por metros)' : 'partes iguales';
    // Unir borraría el registro de lo producido, así que el backend lo rechaza:
    // se esconde el botón en vez de ofrecer algo que va a fallar.
    document.getElementById('envUnir').style.display = (envs.length && !hayCongelado) ? '' : 'none';
    renderEnviosRows();
    document.getElementById('modalEnvios').classList.remove('hidden');
  }
  function renderEnviosRows(){
    var cont = document.getElementById('envRows');
    var soloM = _soloMetros();
    cont.innerHTML = _enviosRows.map(function(r,i){
      // Congelado: tipo y cantidad como texto, sin ✕. La fecha de entrega sigue
      // editable — es el compromiso comercial, no el tamaño de lo que se fabricó.
      if(r.congelado){
        return '<div class="env-row env-row-congelado" data-i="'+i+'" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">'+
          '<span style="font-size:0.82rem;color:var(--cf-gray-text);width:70px;display:inline-block;">'+esc(r.tipo)+'</span>'+
          '<span style="width:100px;font-size:0.82rem;font-weight:700;color:var(--cf-dark);">'+esc(r.valor)+'</span>'+
          '<input data-f="fechaEntrega" type="date" value="'+esc(r.fechaEntrega)+'" title="Fecha de entrega de este envío" style="flex:1;">'+
          '<span class="env-badge" title="Ya se produjo: su tamaño no se puede cambiar">🔒 '+esc(r.motivo)+'</span>'+
        '</div>';
      }
      var tipoCtrl = soloM
        ? '<span style="font-size:0.82rem;color:var(--cf-gray-text);width:70px;display:inline-block;">metros</span>'
        : '<select data-f="tipo">'+
            '<option value="unidades"'+(r.tipo!=='metros'?' selected':'')+'>unidades</option>'+
            '<option value="metros"'+(r.tipo==='metros'?' selected':'')+'>metros</option>'+
          '</select>';
      return '<div class="env-row" data-i="'+i+'" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">'+
        tipoCtrl+
        '<input data-f="valor" type="number" min="1" step="'+(r.tipo==='metros'?'0.01':'1')+'" value="'+esc(r.valor)+'" placeholder="'+(r.tipo==='metros'?'ML':'nº unidades')+'" style="width:100px;">'+
        '<input data-f="fechaEntrega" type="date" value="'+esc(r.fechaEntrega)+'" title="Fecha de entrega de este envío" style="flex:1;">'+
        '<button data-del="'+i+'" class="cola-toggle-btn" title="Quitar envío">✕</button>'+
      '</div>';
    }).join('');
    cont.querySelectorAll('.env-row').forEach(function(row){
      var i = +row.getAttribute('data-i');
      row.querySelectorAll('[data-f]').forEach(function(inp){
        inp.addEventListener('input', function(){ _enviosRows[i][inp.getAttribute('data-f')] = inp.value; actualizarResumenEnvios(); });
        if(inp.getAttribute('data-f')==='tipo') inp.addEventListener('change', function(){ _enviosRows[i].tipo = inp.value; renderEnviosRows(); });
      });
      var del = row.querySelector('[data-del]');
      if(del) del.addEventListener('click', function(){ _enviosRows.splice(i,1); renderEnviosRows(); });
    });
    actualizarResumenEnvios();
  }
  function actualizarResumenEnvios(){
    var sumML=0, sumUnidades=0;
    _enviosRows.forEach(function(r){ sumML += _mlDeRow(r); if(r.tipo!=='metros') sumUnidades += (parseFloat(r.valor)||0); });
    sumML = Math.round(sumML*100)/100;
    var quedan = Math.round((_enviosProy.totalML - sumML)*100)/100;
    var warn = '';
    if(sumML > _enviosProy.totalML + 0.5) warn = ' — ⚠ excede el total';
    else if(sumUnidades > _enviosProy.cantidad) warn = ' — ⚠ excede las unidades';
    var el = document.getElementById('envResumen');
    el.textContent = 'Asignado: '+fmtNum(sumML,0)+' ML de '+fmtNum(_enviosProy.totalML,0)+' · quedan '+fmtNum(quedan,0)+' ML'+warn;
    el.style.color = warn ? '#DC2626' : 'var(--cf-dark)';
  }
  function agregarEnvioRow(){ _enviosRows.push({ id:null, tipo:_soloMetros()?'metros':'unidades', valor:'', fechaEntrega:'' }); renderEnviosRows(); }
  // Reparte el proyecto en N envíos iguales (por unidades si cantidad>1; por metros si es de 1 unidad).
  function aplicarPartesIguales(){
    var N = parseInt(document.getElementById('envPartesN').value) || 0;
    if(N < 2){ toast('Indica al menos 2 partes','error'); return; }
    // Los envíos ya producidos se conservan tal cual y NO entran en el reparto:
    // reemplazar la lista completa los borraría y el backend rechazaría el
    // guardado. Se reparte únicamente lo que queda libre.
    var fijos = _enviosRows.filter(function(r){ return r.congelado; });
    var mlFijo = 0, unidFijas = 0;
    fijos.forEach(function(r){
      mlFijo += _mlDeRow(r);
      if(r.tipo !== 'metros') unidFijas += (parseFloat(r.valor)||0);
    });
    var mlLibre = Math.round((_enviosProy.totalML - mlFijo)*100)/100;
    var unidLibres = _enviosProy.cantidad - unidFijas;
    if(mlLibre <= 0){ toast('No queda nada por repartir: todo el proyecto ya se produjo','error'); return; }
    var rows = [];
    if(_soloMetros()){
      var base = Math.floor(mlLibre / N * 100) / 100;
      var acum = 0;
      for(var i=0;i<N;i++){
        var v = (i===N-1) ? Math.round((mlLibre - acum)*100)/100 : base;
        acum += v;
        rows.push({ id:null, tipo:'metros', valor:v, fechaEntrega:'' });
      }
    } else {
      if(N > unidLibres){
        toast('No puedes partir en más partes que unidades por repartir ('+unidLibres+')','error');
        return;
      }
      var base2 = Math.floor(unidLibres / N);
      var rem = unidLibres % N;   // las primeras `rem` partes llevan una unidad extra
      for(var k=0;k<N;k++){
        rows.push({ id:null, tipo:'unidades', valor: base2 + (k<rem?1:0), fechaEntrega:'' });
      }
    }
    _enviosRows = fijos.concat(rows);
    renderEnviosRows();
  }
  function cerrarEnvios(){ document.getElementById('modalEnvios').classList.add('hidden'); _enviosArchivo=null; }

  // ── Conciliar la carpeta de producción antes de arrancar ─────────────────
  // Se abre cuando "Iniciar producción" se rechaza por falta de carpeta. La
  // idea es no dejar a nadie con un error y la tarea de ir a buscar dónde se
  // arregla: aquí mismo están las carpetas cuyo nombre coincide con el código de
  // la cotización, se vincula una y la producción arranca sin salir de la
  // pantalla.
  //
  // La convención de nombre que hace posible el match es `fecha_CÓDIGO_NOMBRE`,
  // p. ej. `25082026_581.1_MALAMBO`. Las carpetas viejas con prefijo `CB` también
  // se reconocen.
  var _concUid = null, _concFecha = '', _concSug = [];

  function abrirConciliarCarpeta(uid, fecha, datos){
    cerrarIniciar();
    _concUid = uid; _concFecha = fecha; _concSug = (datos && datos.sugerencias) || [];
    var item = buscarItem(uid);
    document.getElementById('concNombre').textContent = item ? etiquetaUnidad(item) : uid;
    document.getElementById('concInfo').textContent =
      'CB ' + ((datos && datos.consecutivo) || '—') + ' · no tiene carpeta de producción vinculada. ' +
      'Sin ella, lo que se fabrique no queda ligado a ningún plano.';
    var cont = document.getElementById('concLista');
    if(_concSug.length){
      cont.innerHTML = '<div class="higiene-titulo">Carpetas cuyo nombre coincide con el código ('+_concSug.length+')</div>' +
        _concSug.map(function(s,i){
          return '<div class="cola-row"><div class="cola-main">'+
            '<div class="cola-nombre">'+esc(s.nombre)+'</div>'+
            '<div class="cola-meta">'+fechaCorta(s.fecha)+' · '+fmtNum(s.metrosTotal,0)+' ML · '+esc(s.estado)+'</div>'+
          '</div>'+
          '<button class="btn btn-primary btn-sm" data-conc="'+i+'">Vincular y arrancar</button>'+
          '</div>';
        }).join('');
      cont.querySelectorAll('[data-conc]').forEach(function(b){
        b.addEventListener('click', function(){ vincularYArrancar(parseInt(b.getAttribute('data-conc'),10)); });
      });
    } else {
      // Sin candidatas hay dos causas y conviene decir las dos: la carpeta no
      // existe todavía en Drive, o existe pero su nombre no lleva el código.
      cont.innerHTML = '<div style="font-size:0.82rem;color:var(--cf-gray-text);line-height:1.5;">'+
        'Ninguna carpeta de Drive tiene este código en el nombre. Puede ser que todavía no exista, '+
        'o que su nombre no siga la convención <strong>fecha_código_nombre</strong> (ej. '+
        '<code>25082026_581.1_MALAMBO</code>).<br>Si acabas de crearla, escanea Drive y vuelve a intentar.'+
        '</div>';
    }
    // El enlace manual apunta a ESTA cotizacion, no al listado: si alguien
    // sale a vincular a mano, que no tenga que buscarla otra vez.
    var p2 = _parseUidLocal(uid);
    document.getElementById('concIrCotiz').href =
      'cotizaciones.html?archivo=' + encodeURIComponent(p2.archivo);
    document.getElementById('modalConciliar').classList.remove('hidden');
  }

  function cerrarConciliar(){
    document.getElementById('modalConciliar').classList.add('hidden');
    _concUid = null; _concSug = [];
  }

  function vincularYArrancar(i){
    var s = _concSug[i]; if(!s || !_concUid) return;
    var uid = _concUid, fecha = _concFecha;
    var p = _parseUidLocal(uid);
    cerrarConciliar();
    beginSave();
    // Vincular primero y arrancar después: si el vínculo falla, no queremos una
    // producción iniciada a medias sin carpeta, que es justo lo que se evita.
    apiCotizVincular(token, p.archivo, s.carpetaId, 'link')
      .then(function(){ return apiProdColaIniciar(token, uid, fecha); })
      .then(function(){ toast('Carpeta vinculada · producción iniciada','ok'); return cargar(); })
      .catch(manejarError).finally(endSave);
  }

  /** Espejo de _parseUid del backend: 'archivo#envioId' → { archivo, envioId }. */
  function _parseUidLocal(uid){
    var s = String(uid||''), i = s.indexOf('#');
    return (i < 0) ? { archivo: s, envioId: '' } : { archivo: s.substring(0,i), envioId: s.substring(i+1) };
  }

  // ── Pausar / reanudar producción ─────────────────────────────────────────
  // Pausar pide el avance porque sin él, al reanudar, el cronograma volvería a
  // agendar la unidad completa. Para que pedirlo no sea una carga, el campo
  // llega prellenado con lo que se habría producido a ritmo normal desde el
  // arranque: el caso normal es confirmar (PLAN_PROGRAMACION.md §7).
  var _pauUid = null, _pauItem = null;

  /**
   * Atajos para responder cuánto se produjo, en la unidad que la planta SÍ sabe
   * contar. Devuelve [{ etiqueta, ml }], siempre por debajo del total (llegar al
   * total es "Finalizar", no pausar).
   *
   * Para una unidad de varias casas se ofrecen casas enteras, porque "terminé 2
   * de 3" es una pregunta contestable; "produje 2500 metros lineales" no lo es.
   * Para una unidad de una sola casa, o medida en metros, no hay nada que contar
   * en enteros y se ofrecen fracciones.
   *
   * PURA: sin DOM, para poder probar la regla caso por caso.
   */
  function opcionesAvance(item){
    var total = Number(item && item.mlTotal) || 0;
    if(total <= 0) return [];
    var out = [];
    var casas = (item.esEnvio && item.tipoEnvio !== 'metros') ? Number(item.valorEnvio)
              : (item.esEnvio ? 0 : Number(item.cantidad));
    var mlCasa = Number(item.mlCasa) || 0;
    if(casas > 1 && mlCasa > 0){
      for(var k = 1; k < casas; k++){
        out.push({ etiqueta: k + (k === 1 ? ' casa' : ' casas'), ml: Math.round(k * mlCasa * 100)/100 });
      }
      return out;
    }
    [0.25, 0.5, 0.75].forEach(function(f){
      out.push({ etiqueta: Math.round(f*100) + '%', ml: Math.round(total * f * 100)/100 });
    });
    return out;
  }

  function abrirPausar(uid, nombre){
    cerrarMenus();
    var c = (_data.cola||[]).filter(function(x){ return x.uid===uid; })[0];
    if(!c){ toast('No se encontró la unidad','error'); return; }
    if(!c.fechaRealInicio){ toast('Esta unidad no ha arrancado producción','error'); return; }
    _pauUid = uid; _pauItem = c;

    // NO se prellena. Antes se proponía "días transcurridos × ritmo", y eso está
    // mal de dos maneras: `ritmo` es el rendimiento de la planta ENTERA, no el de
    // esta unidad —el cronograma empaca en secuencia justamente porque la planta
    // trabaja una a la vez—, y el tope a mlTotal-1 disimulaba el desborde: toda
    // unidad que llevara su duración estimada o más salía prellenada en el 100 %,
    // que es exactamente cuando uno querría pausarla. Un dato inventado con cara
    // de medido acaba en nómina de producción: quien pausa es el único que sabe
    // cuánto salió, igual que el operario con su propia anomalía.
    document.getElementById('pauNombre').textContent = nombre || etiquetaUnidad(c);
    document.getElementById('pauInfo').textContent =
      'Unidad de '+fmtNum(c.mlTotal,0)+' ML'+
      (c.mlCasa > 0 && !c.esEnvio && c.cantidad > 1 ? ' ('+c.cantidad+' casas de '+fmtNum(c.mlCasa,0)+' ML)' : '')+
      ' · arrancó el '+fechaCorta(c.fechaRealInicio);
    var inp = document.getElementById('pauAvance');
    inp.max = c.mlTotal;
    inp.value = '';
    // Atajos: rellenan el campo, no lo deciden.
    var cont = document.getElementById('pauAtajos');
    var ops = opcionesAvance(c);
    cont.innerHTML = ops.length
      ? '<span style="font-size:0.7rem;color:var(--cf-gray-text);">Atajos:</span> ' +
        ops.map(function(o,i){
          return '<button type="button" class="btn btn-ghost btn-sm" data-avance="'+i+'">'+esc(o.etiqueta)+'</button>';
        }).join(' ')
      : '';
    cont.querySelectorAll('[data-avance]').forEach(function(b){
      b.addEventListener('click', function(){
        inp.value = ops[parseInt(b.getAttribute('data-avance'),10)].ml;
        actualizarResumenPausa();
      });
    });
    actualizarResumenPausa();
    document.getElementById('modalPausar').classList.remove('hidden');
    inp.focus();
  }

  function actualizarResumenPausa(){
    if(!_pauItem) return;
    var crudo = document.getElementById('pauAvance').value;
    var v = parseFloat(crudo);
    var el = document.getElementById('pauResumen');
    if(String(crudo).trim() === ''){
      el.textContent = 'Escribe cuántos ML se produjeron: es el dato que decide lo que se agenda al reanudar.';
      el.style.color = 'var(--cf-gray-text)';
      return;
    }
    if(isNaN(v) || v < 0){ el.textContent = 'Escribe cuántos ML se produjeron.'; el.style.color = '#DC2626'; return; }
    if(v >= _pauItem.mlTotal){
      el.textContent = 'Eso es toda la unidad: si ya terminó, usa "Finalizar" en vez de pausar.';
      el.style.color = '#DC2626'; return;
    }
    var falta = Math.round((_pauItem.mlTotal - v)*100)/100;
    var dias = (_pauItem.ritmo > 0) ? Math.round(falta/_pauItem.ritmo*10)/10 : 0;
    el.textContent = 'Quedarían '+fmtNum(falta,0)+' ML por producir (≈'+fmtDias(dias)+' al reanudar).';
    el.style.color = 'var(--cf-dark)';
  }

  function cerrarPausar(){ document.getElementById('modalPausar').classList.add('hidden'); _pauUid=null; _pauItem=null; }

  function guardarPausar(){
    if(!_pauUid || !_pauItem) return;
    var v = parseFloat(document.getElementById('pauAvance').value);
    if(isNaN(v) || v < 0){ toast('Escribe cuántos ML se produjeron','error'); return; }
    if(v >= _pauItem.mlTotal){ toast('El avance cubre toda la unidad: usa "Finalizar"','error'); return; }
    var uid = _pauUid;
    cerrarPausar();
    beginSave();
    apiProdColaPausar(token, uid, v)
      .then(function(){ toast('Producción pausada','ok'); return cargar(); })
      .catch(manejarError).finally(endSave);
  }

  async function reanudarUnidad(uid, nombre){
    cerrarMenus();
    if(!await confirmar({ titulo:'Reanudar producción',
      mensaje:'¿Reanudar "'+(nombre||uid)+'"? Vuelve a la cola en su mismo puesto y se agenda solo lo que falta.',
      btnOk:'Reanudar' })) return;
    beginSave();
    apiProdColaReanudar(token, uid)
      .then(function(){ toast('Producción reanudada','ok'); return cargar(); })
      .catch(manejarError).finally(endSave);
  }

  // ── Partir UN envío, conservando su puesto en la cola ────────────────────
  // Distinto de "Partir en envíos": ese redefine el reparto del proyecto entero
  // y valida contra el total; este CONSERVA — las partes tienen que sumar lo
  // mismo que tenía el envío. Y el backend les da el `orden` del padre, así que
  // las partes no se van al final de la cola.
  var _parUid = null, _parEnvio = null, _parRows = [];

  function abrirPartir(uid){
    cerrarMenus();
    var c = _data.cola.concat(_data.backlog||[]).filter(function(x){ return x.uid===uid; })[0];
    if(!c){ toast('No se encontró el envío','error'); return; }
    if(!c.esEnvio){ toast('Este proyecto no está partido en envíos: usa "Partir en envíos"','error'); return; }
    if(c.fechaRealInicio){
      toast('Este envío ya arrancó su producción: no se puede partir','error');
      return;
    }
    _parUid = uid;
    _parEnvio = { archivo:c.archivo, envioId:c.envioId, ml:c.mlTotal, mlCasa:c.mlCasa,
                  tipo:c.tipoEnvio, valor:c.valorEnvio, fechaEntrega:c.fechaEntrega||'',
                  etiqueta:etiquetaUnidad(c) };
    // Una sola casa no se parte por unidades: solo por metros.
    var porUnidades = (c.tipoEnvio !== 'metros' && c.valorEnvio > 1);
    _parRows = [porUnidades
      ? { tipo:'unidades', valor:'', fechaEntrega:'' }
      : { tipo:'metros', valor:'', fechaEntrega:'' }];
    document.getElementById('parEnvioNombre').textContent = _parEnvio.etiqueta;
    document.getElementById('parTotalInfo').textContent =
      'Este envío: '+fmtNum(_parEnvio.ml,0)+' ML'+
      (c.tipoEnvio!=='metros' ? ' ('+nUnidades(c.valorEnvio)+')' : '')+
      ' — las partes tienen que sumar exactamente eso.';
    document.getElementById('parPartesUnidad').textContent = porUnidades ? 'partes iguales' : 'partes iguales (por metros)';
    aplicarPartirIguales();   // arranca con la propuesta de 2 mitades, que es el caso común
    document.getElementById('modalPartir').classList.remove('hidden');
  }

  function _mlDeParte(r){
    var v = parseFloat(r.valor) || 0;
    return r.tipo === 'metros' ? v : v * (_parEnvio.mlCasa || 0);
  }

  function renderPartirRows(){
    var cont = document.getElementById('parRows');
    var porUnidades = (_parEnvio.tipo !== 'metros' && _parEnvio.valor > 1);
    cont.innerHTML = _parRows.map(function(r,i){
      var tipoCtrl = porUnidades
        ? '<select data-f="tipo">'+
            '<option value="unidades"'+(r.tipo!=='metros'?' selected':'')+'>unidades</option>'+
            '<option value="metros"'+(r.tipo==='metros'?' selected':'')+'>metros</option>'+
          '</select>'
        : '<span style="font-size:0.82rem;color:var(--cf-gray-text);width:70px;display:inline-block;">metros</span>';
      return '<div class="env-row" data-i="'+i+'" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">'+
        tipoCtrl+
        '<input data-f="valor" type="number" min="0" step="'+(r.tipo==='metros'?'0.01':'1')+'" value="'+esc(r.valor)+'" placeholder="'+(r.tipo==='metros'?'ML':'nº unidades')+'" style="width:100px;">'+
        '<input data-f="fechaEntrega" type="date" value="'+esc(r.fechaEntrega)+'" title="Fecha de entrega de esta parte (vacío = hereda la del envío)" style="flex:1;">'+
        '<button data-del="'+i+'" class="cola-toggle-btn" title="Quitar parte">✕</button>'+
      '</div>';
    }).join('');
    cont.querySelectorAll('.env-row').forEach(function(row){
      var i = +row.getAttribute('data-i');
      row.querySelectorAll('[data-f]').forEach(function(inp){
        inp.addEventListener('input', function(){ _parRows[i][inp.getAttribute('data-f')] = inp.value; actualizarResumenPartir(); });
        if(inp.getAttribute('data-f')==='tipo') inp.addEventListener('change', function(){ _parRows[i].tipo = inp.value; renderPartirRows(); });
      });
      row.querySelector('[data-del]').addEventListener('click', function(){ _parRows.splice(i,1); renderPartirRows(); });
    });
    actualizarResumenPartir();
  }

  function actualizarResumenPartir(){
    var suma = 0;
    _parRows.forEach(function(r){ suma += _mlDeParte(r); });
    suma = Math.round(suma*100)/100;
    var dif = Math.round((_parEnvio.ml - suma)*100)/100;
    var el = document.getElementById('parResumen');
    var txt = 'Asignado: '+fmtNum(suma,0)+' ML de '+fmtNum(_parEnvio.ml,0)+' ML';
    if(Math.abs(dif) > 0.5) txt += ' — ⚠ '+(dif>0 ? 'faltan '+fmtNum(dif,0)+' ML' : 'sobran '+fmtNum(-dif,0)+' ML');
    else txt += ' — ✓ cuadra';
    el.textContent = txt;
    el.style.color = (Math.abs(dif) > 0.5) ? '#DC2626' : '#16A34A';
  }

  function aplicarPartirIguales(){
    var N = parseInt(document.getElementById('parPartesN').value) || 0;
    if(N < 2){ toast('Indica al menos 2 partes','error'); return; }
    var porUnidades = (_parEnvio.tipo !== 'metros' && _parEnvio.valor > 1);
    var rows = [];
    if(porUnidades && N <= _parEnvio.valor){
      // Reparto por casas enteras: las primeras `rem` partes llevan una extra.
      var base = Math.floor(_parEnvio.valor / N), rem = _parEnvio.valor % N;
      for(var k=0;k<N;k++) rows.push({ tipo:'unidades', valor: base + (k<rem?1:0), fechaEntrega:'' });
    } else {
      // Por metros: la última parte absorbe el redondeo para que la suma cuadre
      // exacta — el backend exige que conserve, con 0,5 ML de tolerancia.
      var b = Math.floor(_parEnvio.ml / N * 100) / 100, acum = 0;
      for(var i=0;i<N;i++){
        var v = (i===N-1) ? Math.round((_parEnvio.ml - acum)*100)/100 : b;
        acum += v;
        rows.push({ tipo:'metros', valor:v, fechaEntrega:'' });
      }
    }
    _parRows = rows;
    renderPartirRows();
  }

  function cerrarPartir(){ document.getElementById('modalPartir').classList.add('hidden'); _parUid=null; _parEnvio=null; }

  function guardarPartir(){
    if(!_parEnvio) return;
    if(_parRows.length < 2){ toast('Para partir hay que indicar al menos 2 partes','error'); return; }
    var suma = 0;
    for(var i=0;i<_parRows.length;i++){
      var r = _parRows[i], v = parseFloat(r.valor);
      if(!(v>0)){ toast('Cada parte debe tener un valor mayor a 0','error'); return; }
      if(r.tipo!=='metros' && v!==Math.floor(v)){ toast('Las partes por unidades deben ser un número entero','error'); return; }
      suma += _mlDeParte(r);
    }
    if(Math.abs(suma - _parEnvio.ml) > 0.5){
      toast('Las partes suman '+fmtNum(Math.round(suma),0)+' ML y el envío tiene '+fmtNum(_parEnvio.ml,0)+' ML','error');
      return;
    }
    var partes = _parRows.map(function(r){
      var o = { tipo:r.tipo, valor:parseFloat(r.valor) };
      if(r.fechaEntrega) o.fechaEntrega = r.fechaEntrega;
      return o;
    });
    var archivo = _parEnvio.archivo, envioId = _parEnvio.envioId, n = partes.length;
    cerrarPartir();
    beginSave();
    apiProdEnvioPartir(token, archivo, envioId, partes)
      .then(function(){ toast('Envío partido en '+n+' partes','ok'); return cargar(); })
      .catch(manejarError).finally(endSave);
  }
  function guardarEnvios(){
    var archivo = _enviosArchivo; if(!archivo) return;
    if(!_enviosRows.length){ toast('Agrega al menos un envío, o usa "Unir"','error'); return; }
    var sumML=0, sumUnidades=0;
    for(var i=0;i<_enviosRows.length;i++){
      var r=_enviosRows[i], v=parseFloat(r.valor);
      if(!(v>0)){ toast('Cada envío debe tener un valor mayor a 0','error'); return; }
      if(r.tipo!=='metros' && v!==Math.floor(v)){ toast('Los envíos por unidades deben ser un número entero','error'); return; }
      sumML += _mlDeRow(r); if(r.tipo!=='metros') sumUnidades += v;
    }
    if(sumML > _enviosProy.totalML + 0.5){ toast('Los envíos exceden el total del proyecto','error'); return; }
    if(sumUnidades > _enviosProy.cantidad){ toast('Los envíos exceden las unidades del proyecto','error'); return; }
    var payload = _enviosRows.map(function(r){ var o={ tipo:r.tipo, valor:parseFloat(r.valor), fechaEntrega:r.fechaEntrega||'' }; if(r.id) o.id=r.id; return o; });
    cerrarEnvios();
    beginSave();
    apiProdEnviosSet(token, archivo, payload).then(function(){ toast('Envíos guardados','ok'); return cargar(); })
      .catch(manejarError).finally(endSave);
  }
  function unirEnvios(){
    var archivo = _enviosArchivo; if(!archivo) return;
    cerrarEnvios();
    beginSave();
    apiProdEnviosSet(token, archivo, []).then(function(){ toast('Proyecto unido (un solo bloque)','ok'); return cargar(); })
      .catch(manejarError).finally(endSave);
  }

  // Sacar de la cola → backlog (optimista). El resto de la cola se re-agenda solo.
  function sacarDeCola(uid){
    var idx = _data.cola.map(function(c){return c.uid;}).indexOf(uid);
    if(idx<0) return;
    var item = _data.cola[idx];
    _data.cola.splice(idx,1);
    _data.backlog = _data.backlog || [];
    _data.backlog.push(item);
    recomputarYRenderizar();
    beginSave();
    apiProdColaToggle(token, uid, false).then(function(){
      toast('Sacado de la cola','ok');
    }).catch(function(e){
      var b = _data.backlog.map(function(x){return x.uid;}).indexOf(uid);
      if(b>=0) _data.backlog.splice(b,1);
      _data.cola.splice(idx,0,item);
      recomputarYRenderizar();
      manejarError(e);
    }).finally(endSave);
  }

  // Agregar de backlog → cola (optimista, al final). El servidor le fija orden=max+1.
  function agregarACola(uid){
    _data.backlog = _data.backlog || [];
    var idx = _data.backlog.map(function(x){return x.uid;}).indexOf(uid);
    if(idx<0) return;
    var item = _data.backlog[idx];
    _data.backlog.splice(idx,1);
    _data.cola.push(item);
    recomputarYRenderizar();
    beginSave();
    apiProdColaToggle(token, uid, true).then(function(){
      toast('Agregado a la cola','ok');
    }).catch(function(e){
      var c = _data.cola.map(function(x){return x.uid;}).indexOf(uid);
      if(c>=0) _data.cola.splice(c,1);
      _data.backlog.splice(idx,0,item);
      recomputarYRenderizar();
      manejarError(e);
    }).finally(endSave);
  }

  // ── Reordenar cola (optimista, coalescido) — flechas ▲▼ y arrastrar ──
  var _colaBefore = null; // snapshot de uids-en-orden antes de la primera acción de una ráfaga
  function reordenarSegun(uids){
    var byUid = {}; _data.cola.forEach(function(c){ byUid[c.uid]=c; });
    _data.cola = uids.map(function(a){ return byUid[a]; }).filter(Boolean);
    recomputarYRenderizar();
  }
  function aplicarNuevoOrden(colaNueva){
    if(_colaBefore===null) _colaBefore = _data.cola.map(function(c){ return c.uid; });
    _data.cola = colaNueva;
    recomputarYRenderizar();

    var orden = _data.cola.map(function(c){ return c.uid; });
    debounceSave('cola_orden', 400, function(){
      return apiProdColaReordenar(token, orden).then(function(){
        _colaBefore = null;
      }).catch(function(e){
        var uidsPrevios = _colaBefore; _colaBefore = null;
        if(uidsPrevios) reordenarSegun(uidsPrevios);
        manejarError(e);
      });
    });
  }
  // Mueve el elemento que está en `desde` (índice 0-based) al puesto
  // `destino1based` (1..n, con clamp), y devuelve una lista NUEVA.
  //
  // Pura a propósito: es la única pieza de este reorden que decide prioridades de
  // producción, y así se puede probar caso por caso sin DOM
  // (tests/cola_reorden.test.js). No muta la lista recibida porque
  // aplicarNuevoOrden se queda con la anterior para revertir si falla el guardado.
  //
  // El destino se aplica sobre la lista ya SIN el elemento, que es lo que
  // significa "ponelo en el puesto 3" para quien lo escribe. Misma semántica que
  // reordenarLinea en los ítems de la remisión, para que las dos pantallas no se
  // comporten distinto ante el mismo gesto.
  function nuevoOrdenPorNumero(lista, desde, destino1based){
    var n = lista.length;
    if (desde < 0 || desde >= n) return lista.slice();
    var destino = parseInt(destino1based, 10);
    if (!destino || destino < 1) destino = 1;
    if (destino > n) destino = n;
    var destino0 = destino - 1;
    if (destino0 === desde) return lista.slice();
    var out = lista.slice();
    var item = out.splice(desde, 1)[0];
    out.splice(destino0, 0, item);
    return out;
  }

  // Reordena escribiendo el puesto destino, en vez de arrastrar: con la cola ya
  // larga, llevar un proyecto del final al principio a fuerza de arrastre era
  // impracticable. Se confirma en 'change' (Enter o al salir del campo), no en
  // cada tecla, para no reordenar a media cifra de un número de dos dígitos.
  function reordenarUnidad(i, destino){
    var cola = nuevoOrdenPorNumero(_data.cola, i, destino);
    // Sin cambio real: se repinta igual para que el input vuelva a mostrar el
    // número que le corresponde si se escribió algo fuera de rango.
    if (cola.map(function(c){return c.uid;}).join('|') === _data.cola.map(function(c){return c.uid;}).join('|')) {
      recomputarYRenderizar();
      return;
    }
    aplicarNuevoOrden(cola);
  }

  // Arrastra `uid` a la posición de `targetUid` (antes o después, según `after`).
  function reordenarPorDrop(uid, targetUid, after){
    if(uid === targetUid) return;
    var cola = _data.cola.slice();
    var fromIdx = cola.map(function(c){return c.uid;}).indexOf(uid);
    if(fromIdx<0) return;
    var item = cola.splice(fromIdx,1)[0];
    var toIdx = cola.map(function(c){return c.uid;}).indexOf(targetUid);
    if(toIdx<0) toIdx = cola.length;
    if(after) toIdx++;
    cola.splice(toIdx,0,item);
    aplicarNuevoOrden(cola);
  }

  var _dragUid = null;
  function bindDragDrop(body){
    body.querySelectorAll('.cola-drag-handle').forEach(function(h){
      h.addEventListener('dragstart', function(e){
        _dragUid = h.getAttribute('data-uid');
        e.dataTransfer.effectAllowed = 'move';
        try{ e.dataTransfer.setData('text/plain', _dragUid); }catch(err){}
        var row = h.closest('.cola-row');
        if(row) row.classList.add('dragging');
      });
      h.addEventListener('dragend', function(){
        body.querySelectorAll('.cola-row').forEach(function(r){ r.classList.remove('dragging','drop-before','drop-after'); });
        _dragUid = null;
      });
    });
    body.querySelectorAll('.cola-row').forEach(function(row){
      row.addEventListener('dragover', function(e){
        if(!_dragUid) return;
        e.preventDefault();
        var rect = row.getBoundingClientRect();
        var after = (e.clientY - rect.top) > rect.height/2;
        row.classList.toggle('drop-after', after);
        row.classList.toggle('drop-before', !after);
      });
      row.addEventListener('dragleave', function(){
        row.classList.remove('drop-before','drop-after');
      });
      row.addEventListener('drop', function(e){
        e.preventDefault();
        var after = row.classList.contains('drop-after');
        row.classList.remove('drop-before','drop-after');
        if(_dragUid) reordenarPorDrop(_dragUid, row.getAttribute('data-uid'), after);
        _dragUid = null;
      });
    });
  }

  // ── Fecha de entrega (optimista, coalescida por unidad) ──
  function cambiarEntrega(uid, fecha){
    var item = _data.cola.filter(function(c){ return c.uid===uid; })[0];
    if(!item) return;
    var before = item.fechaEntrega;
    item.fechaEntrega = fecha;
    recomputarYRenderizar();

    debounceSave('entrega_'+uid, 350, function(){
      return apiProdColaEntrega(token, uid, fecha).then(function(){
        toast(fecha?'Fecha de entrega guardada':'Fecha de entrega quitada','ok');
      }).catch(function(e){
        var it = _data.cola.filter(function(c){ return c.uid===uid; })[0];
        if(it) it.fechaEntrega = before;
        recomputarYRenderizar();
        manejarError(e);
      });
    });
  }

  // ── Marcar día laborable/no laborable (optimista, coalescido por día) ──
  var _excBefore = {}; // ISO → snapshot antes del primer clic de una ráfaga sobre ese día
  function toggleDia(iso){
    if(!(iso in _excBefore)) _excBefore[iso] = _exc[iso] ? Object.assign({}, _exc[iso]) : null;

    var accion, laborableToSend;
    if(_exc[iso]){
      delete _exc[iso];
      accion = 'del'; laborableToSend = false;              // quitar excepción → vuelve a default
    } else {
      var laborableDefault = (isoDow(iso)!==0 && !_festivos[iso]);
      var nuevoLaborable = !laborableDefault;                // invertir el default
      _exc[iso] = { laborable: nuevoLaborable, nota: nuevoLaborable ? 'Laborable (manual)' : 'No laborable (manual)' };
      accion = 'set'; laborableToSend = nuevoLaborable;
    }
    recomputarYRenderizar();

    debounceSave('exc_'+iso, 350, function(){
      return apiProdCalExcepcion(token, iso, laborableToSend, accion).then(function(){
        delete _excBefore[iso];
      }).catch(function(e){
        var before = _excBefore[iso]; delete _excBefore[iso];
        if(before) _exc[iso]=before; else delete _exc[iso];
        recomputarYRenderizar();
        manejarError(e);
      });
    });
  }

  // ── Config (ritmo / inicio) — ahora optimista: cada ítem trae su ritmoOvr,
  // así que se puede recalcular todo localmente sin esperar al servidor. ──
  function guardarConfig(){
    var ritmoStr  = document.getElementById('cfgRitmo').value;
    var inicioStr = document.getElementById('cfgInicio').value;
    if(ritmoStr && !(Number(ritmoStr) > 0)){ toast('El ritmo debe ser mayor a 0','error'); return; }

    var before = { ritmoMlDia: _data.config.ritmoMlDia, fechaInicioCola: _data.config.fechaInicioCola };
    var hoy = todayISO();
    if(ritmoStr)  _data.config.ritmoMlDia = Number(ritmoStr);
    if(inicioStr) _data.config.fechaInicioCola = inicioStr < hoy ? hoy : inicioStr;   // mismo tope que el backend
    recomputarYRenderizar();

    beginSave();
    apiProdColaConfig(token, ritmoStr, inicioStr).then(function(){
      toast('Configuración guardada','ok');
    }).catch(function(e){
      _data.config.ritmoMlDia = before.ritmoMlDia;
      _data.config.fechaInicioCola = before.fechaInicioCola;
      document.getElementById('cfgRitmo').value = before.ritmoMlDia || '';
      document.getElementById('cfgInicio').value = before.fechaInicioCola || '';
      recomputarYRenderizar();
      manejarError(e);
    }).finally(endSave);
  }

  // ── Init ──
  function init(){
    document.getElementById('modNav').classList.remove('hidden');
    document.getElementById('logoutBtn').addEventListener('click', function(){ clearSession(); location.href='index.html'; });
    document.getElementById('btnCfgGuardar').addEventListener('click', guardarConfig);
    document.getElementById('btnMesPrev').addEventListener('click', function(){ _mesM--; if(_mesM<0){_mesM=11;_mesY--;} renderCalendario(); });
    document.getElementById('btnMesNext').addEventListener('click', function(){ _mesM++; if(_mesM>11){_mesM=0;_mesY++;} renderCalendario(); });
    document.getElementById('finCancelar').addEventListener('click', cerrarFinalizar);
    document.getElementById('finConfirmar').addEventListener('click', confirmarFinalizar);
    document.getElementById('modalFinalizar').addEventListener('click', function(e){ if(e.target.id==='modalFinalizar') cerrarFinalizar(); });
    document.getElementById('ajCancelar').addEventListener('click', cerrarAjustes);
    document.getElementById('ajGuardar').addEventListener('click', guardarAjustes);
    document.getElementById('ajLimpiar').addEventListener('click', limpiarAjustesModal);
    document.getElementById('modalAjustes').addEventListener('click', function(e){ if(e.target.id==='modalAjustes') cerrarAjustes(); });
    document.getElementById('envAgregar').addEventListener('click', agregarEnvioRow);
    document.getElementById('envPartesAplicar').addEventListener('click', aplicarPartesIguales);
    document.getElementById('envCancelar').addEventListener('click', cerrarEnvios);
    document.getElementById('envGuardar').addEventListener('click', guardarEnvios);
    document.getElementById('envUnir').addEventListener('click', unirEnvios);
    document.getElementById('parAgregar').addEventListener('click', function(){
      _parRows.push({ tipo:(_parEnvio && _parEnvio.tipo!=='metros' && _parEnvio.valor>1)?'unidades':'metros', valor:'', fechaEntrega:'' });
      renderPartirRows();
    });
    document.getElementById('parPartesAplicar').addEventListener('click', aplicarPartirIguales);
    document.getElementById('parCancelar').addEventListener('click', cerrarPartir);
    document.getElementById('parGuardar').addEventListener('click', guardarPartir);
    document.getElementById('concCancelar').addEventListener('click', cerrarConciliar);
    document.getElementById('concEscanear').addEventListener('click', function(){
      var b = this; b.disabled = true; b.textContent = 'Escaneando…';
      // Reintenta el arranque después del escaneo: si la carpeta ya estaba en
      // Drive pero sin escanear, esto la encuentra y el modal se repuebla solo.
      apiProdScanNow(token)
        .then(function(){ var u = _concUid, f = _concFecha; cerrarConciliar(); if(u) marcarInicio(u, f); })
        .catch(manejarError)
        .finally(function(){ b.disabled = false; b.textContent = '↻ Escanear Drive'; });
    });
    document.getElementById('pauCancelar').addEventListener('click', cerrarPausar);
    document.getElementById('pauGuardar').addEventListener('click', guardarPausar);
    document.getElementById('pauAvance').addEventListener('input', actualizarResumenPausa);
    document.getElementById('modalEnvios').addEventListener('click', function(e){ if(e.target.id==='modalEnvios') cerrarEnvios(); });
    document.getElementById('notaCancelar').addEventListener('click', cerrarNota);
    document.getElementById('notaGuardar').addEventListener('click', guardarNota);
    document.getElementById('modalNota').addEventListener('click', function(e){ if(e.target.id==='modalNota') cerrarNota(); });
    document.getElementById('iniCancelar').addEventListener('click', cerrarIniciar);
    document.getElementById('iniConfirmar').addEventListener('click', confirmarIniciar);
    document.getElementById('iniQuitar').addEventListener('click', quitarInicio);
    document.getElementById('modalIniciar').addEventListener('click', function(e){ if(e.target.id==='modalIniciar') cerrarIniciar(); });
    document.getElementById('cfgVerFinalizados').addEventListener('change', function(){
      _verFinalizados = this.checked;
      indexarDias(); renderCalendario();   // solo afecta al calendario, no re-agenda nada
    });
    document.getElementById('higieneRefrescar').addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();   // el botón vive dentro de <summary>: no debe togglear el panel
      cargarHigiene();
    });
    // Cerrar el menú ⋯ al hacer clic fuera de él, o con Escape
    document.addEventListener('click', function(e){ if(!e.target.closest('.row-actions')) cerrarMenus(); });
    document.addEventListener('keydown', function(e){ if(e.key==='Escape') cerrarMenus(); });
    cargar();
    cargarHigiene();
  }
  init();
})();
