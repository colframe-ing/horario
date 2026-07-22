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
    el.title = 'Calculado con las últimas '+rr.n+' unidades finalizadas ('+fechaCorta(rr.desde)+' → '+fechaCorta(rr.hasta)+'): '+fmtNum(rr.ml,0)+' ML en '+rr.dias+' días hábiles.';
    el.textContent = 'Ritmo real: '+fmtNum(rr.valor,0)+' ML/día'+(pct!=null?' ('+pct+'% del configurado)':'');
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
      var durDias = ritmo > 0 ? totalML / ritmo : 0;
      var iniCot, finCot, diasSpan, enProd = false;

      if(it.fechaRealInicio){
        // EN PRODUCCIÓN: anclado a su inicio REAL (aunque sea pasado), no a la cola.
        enProd = true;
        iniCot = it.fechaRealInicio;
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
        orden: idx+1, color: color, ritmo: ritmo, enProduccion: enProd,
        mlTotal: Math.round(totalML*100)/100, durDias: Math.round(durDias*100)/100, dias: diasSpan,
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
    if(!cola.length){
      body.innerHTML = '<div style="text-align:center;padding:20px;color:var(--cf-gray-text);font-size:0.85rem;">No hay cotizaciones aprobadas. Aprueba cotizaciones para armar la cola.</div>';
      return;
    }
    body.innerHTML = cola.map(function(c,i){
      var atraso = c.atrasado ? '<span class="cola-atraso">Atrasado</span>' :
                   (c.fechaEntrega ? '<span class="cola-ok">A tiempo</span>' : '');
      var rango = fechaCorta(c.inicio)+' → '+fechaCorta(c.fin);
      return '<div class="cola-row" data-uid="'+esc(c.uid)+'">'+
        '<div class="cola-drag-handle" draggable="true" data-uid="'+esc(c.uid)+'" title="Arrastrar para reordenar">⠿</div>'+
        '<div class="cola-color" style="background:'+c.color+';"></div>'+
        '<div class="cola-main">'+
          '<div class="cola-nombre">'+esc(c.proyecto)+' <span style="font-weight:400;color:var(--cf-gray-text);font-size:0.72rem;">CB'+esc(c.consecutivo)+'</span>'+envioBadge(c)+
            (c.fechaRealInicio?'<span class="prod-badge" title="Producción iniciada el '+esc(fechaCorta(c.fechaRealInicio))+'">▶ En producción</span>':'')+'</div>'+
          '<div class="cola-meta">'+tamanoUnidad(c)+' · ≈'+fmtDias(c.durDias)+(c.vinculadas?' · 🔗'+c.vinculadas:'')+metaAjustes(c)+
            (c.fechaRealInicio?' · inició '+fechaCorta(c.fechaRealInicio):'')+'</div>'+
          '<div class="cola-fechas">'+rango+'</div>'+
        '</div>'+
        '<div class="cola-entrega">'+
          '<span style="font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;color:var(--cf-gray-text);">Entrega</span>'+
          '<input type="date" value="'+esc(c.fechaEntrega)+'" data-entrega="'+esc(c.uid)+'" title="Fecha comprometida con el cliente">'+
          atraso+
        '</div>'+
        rowMenu(
          '<button data-iniciar="'+esc(c.uid)+'" data-nombre="'+esc(etiquetaUnidad(c))+'">▶ '+(c.fechaRealInicio?'Editar inicio real':'Iniciar producción')+'</button>'+
          '<button data-partir="'+esc(c.archivo)+'">✂ Partir en envíos</button>'+
          '<button data-ajustes="'+esc(c.uid)+'" data-nombre="'+esc(etiquetaUnidad(c))+'">⚙ Ritmo / fecha de inicio</button>'+
          '<div class="menu-sep"></div>'+
          '<button data-sacar="'+esc(c.uid)+'">Sacar de la cola</button>'+
          '<button class="danger" data-finalizar="'+esc(c.uid)+'" data-nombre="'+esc(etiquetaUnidad(c))+'">Finalizar</button>'
        )+
      '</div>';
    }).join('');

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
    body.querySelectorAll('[data-iniciar]').forEach(function(b){
      b.addEventListener('click', function(){ abrirIniciar(b.getAttribute('data-iniciar'), b.getAttribute('data-nombre')); });
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
    body.innerHTML = bl.map(function(c){
      return '<div class="cola-row" data-uid="'+esc(c.uid)+'">'+
        '<div class="cola-color" style="background:var(--cf-gray-mid);"></div>'+
        '<div class="cola-main">'+
          '<div class="cola-nombre">'+esc(c.proyecto)+' <span style="font-weight:400;color:var(--cf-gray-text);font-size:0.72rem;">CB'+esc(c.consecutivo)+'</span>'+envioBadge(c)+'</div>'+
          '<div class="cola-meta">'+tamanoUnidad(c)+' · ≈'+fmtDias(c.durDias)+(c.vinculadas?' · 🔗'+c.vinculadas:'')+metaAjustes(c)+'</div>'+
        '</div>'+
        '<button class="cola-toggle-btn add" data-agregar="'+esc(c.uid)+'" title="Agregar al Gantt (se programa al final de la cola)">+ Agregar a la cola</button>'+
        rowMenu(
          '<button data-partir="'+esc(c.archivo)+'">✂ Partir en envíos</button>'+
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
          '<div class="cola-nombre">'+esc(c.proyecto)+' <span style="font-weight:400;color:var(--cf-gray-text);font-size:0.72rem;">CB'+esc(c.consecutivo)+'</span>'+envioBadge(c)+'</div>'+
          '<div class="cola-meta">'+tamanoUnidad(c)+(c.vinculadas?' · 🔗'+c.vinculadas:'')+'</div>'+
          '<div class="cola-fechas">Entrega: '+(c.fechaEntrega?fechaCorta(c.fechaEntrega):'—')+' · Real: '+
            (c.fechaRealInicio ? fechaCorta(c.fechaRealInicio)+' → '+fechaCorta(c.fechaReal) : fechaCorta(c.fechaReal))+'</div>'+
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
    var sc = resp.sinCarpeta || [], sq = resp.sinCotizacion || [];
    if(!sc.length && !sq.length){ card.style.display='none'; return; }
    card.style.display='';

    document.getElementById('higieneSinCarpeta').innerHTML = !sc.length ? '' :
      '<div class="higiene-titulo">Cotizaciones aprobadas sin carpeta vinculada ('+sc.length+')</div>' +
      sc.map(function(x){
        return '<div class="cola-row"><div class="cola-main">'+
          '<div class="cola-nombre">'+esc(x.proyecto)+' <span style="font-weight:400;color:var(--cf-gray-text);font-size:0.72rem;">CB'+esc(x.consecutivo)+'</span></div>'+
          '<div class="cola-meta">'+nUnidades(x.cantidad)+' · '+fmtNum(x.mlTotal,0)+' ML · '+(x.estado==='backlog'?'sin cola':'en cola')+'</div>'+
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
    apiProdColaFinalizar(token, uid, fechaReal, fechaRealInicio || '').then(function(){
      toast('Finalizado','ok');
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
    _enviosRows = envs.map(function(c){ return { id:c.envioId, tipo:c.tipoEnvio, valor:c.valorEnvio, fechaEntrega:c.fechaEntrega||'' }; });
    if(!_enviosRows.length){
      _enviosRows = [_soloMetros()
        ? { id:null, tipo:'metros', valor:'', fechaEntrega:'' }
        : { id:null, tipo:'unidades', valor:Math.ceil(_enviosProy.cantidad/2), fechaEntrega:'' }];
    }
    document.getElementById('envProyectoNombre').textContent = _enviosProy.proyecto || '';
    document.getElementById('envTotalInfo').textContent = 'Total del proyecto: '+nUnidades(_enviosProy.cantidad)+' · '+fmtNum(_enviosProy.totalML,0)+' ML'+
      (_soloMetros() ? ' — proyecto de 1 unidad: solo se puede partir por metros' : '');
    // Etiqueta de "partir en N partes": por unidades o por metros según el proyecto
    document.getElementById('envPartesUnidad').textContent = _soloMetros() ? 'partes iguales (por metros)' : 'partes iguales';
    document.getElementById('envUnir').style.display = envs.length ? '' : 'none';
    renderEnviosRows();
    document.getElementById('modalEnvios').classList.remove('hidden');
  }
  function renderEnviosRows(){
    var cont = document.getElementById('envRows');
    var soloM = _soloMetros();
    cont.innerHTML = _enviosRows.map(function(r,i){
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
      row.querySelector('[data-del]').addEventListener('click', function(){ _enviosRows.splice(i,1); renderEnviosRows(); });
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
    var rows = [];
    if(_soloMetros()){
      var base = Math.floor(_enviosProy.totalML / N * 100) / 100;
      var acum = 0;
      for(var i=0;i<N;i++){
        var v = (i===N-1) ? Math.round((_enviosProy.totalML - acum)*100)/100 : base;
        acum += v;
        rows.push({ id:null, tipo:'metros', valor:v, fechaEntrega:'' });
      }
    } else {
      if(N > _enviosProy.cantidad){ toast('No puedes partir en más partes que unidades ('+_enviosProy.cantidad+')','error'); return; }
      var base2 = Math.floor(_enviosProy.cantidad / N);
      var rem = _enviosProy.cantidad % N;   // las primeras `rem` partes llevan una unidad extra
      for(var k=0;k<N;k++){
        rows.push({ id:null, tipo:'unidades', valor: base2 + (k<rem?1:0), fechaEntrega:'' });
      }
    }
    _enviosRows = rows;
    renderEnviosRows();
  }
  function cerrarEnvios(){ document.getElementById('modalEnvios').classList.add('hidden'); _enviosArchivo=null; }
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
    document.getElementById('modalEnvios').addEventListener('click', function(e){ if(e.target.id==='modalEnvios') cerrarEnvios(); });
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
