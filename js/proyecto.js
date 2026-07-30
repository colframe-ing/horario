// ============================================================
// HOJA DE VIDA DEL PROYECTO — agrupado por consecutivo CB
// Fase 1: vista de solo lectura (sin línea de tiempo ni bitácora).
// ============================================================
(function () {
  'use strict';

  var session = getSession();
  if (!session || !session.token) { location.href = 'index.html'; return; }
  if (!session.esAdmin) { location.href = 'produccion.html'; return; }
  var token = session.token;

  var MESES_COR = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function fmtNum(n,d){ if(n==null||n==='')return '—'; var v=Number(n); if(isNaN(v))return '—'; return v.toLocaleString('es-CO',{minimumFractionDigits:d||0,maximumFractionDigits:d||0}); }
  function fmtMoney(n){ if(n==null||n===''||isNaN(Number(n)))return '—'; return '$'+Number(n).toLocaleString('es-CO',{maximumFractionDigits:0}); }
  function fechaCorta(iso){ if(!iso)return '—'; var p=String(iso).substring(0,10).split('-'); if(p.length<3)return '—'; return parseInt(p[2])+' '+MESES_COR[parseInt(p[1])-1]+' '+p[0]; }
  function nUnidades(n){ return n+(n>1?' unidades':' unidad'); }
  function toast(msg,tipo){
    var c=document.getElementById('toastContainer'), el=document.createElement('div');
    el.style.cssText='pointer-events:auto;background:'+(tipo==='error'?'#DC2626':'#071D49')+';color:#fff;padding:10px 16px;border-radius:10px;font-size:0.82rem;font-weight:600;max-width:320px;';
    el.textContent=msg; c.appendChild(el); setTimeout(function(){el.remove();},4000);
  }

  var ESTADO_TXT = {
    en_produccion:'En producción', en_cola:'En cola', sin_cola:'Aprobado sin cola',
    finalizado:'Finalizado', sin_aprobar:'Sin aprobar',
  };
  var SECCION = {
    cola:{txt:'En cola',cls:'cola'}, backlog:{txt:'Sin cola',cls:'back'}, finalizada:{txt:'Finalizado',cls:'fin'},
  };

  // Etapas del ciclo real. Remisión y facturación aún no tienen módulo: se
  // muestran atenuadas para que la hoja refleje el proceso completo sin fingir
  // que hay datos.
  function etapasHtml(d) {
    var t = d.totales;
    var hayAprob = t.aprobadas > 0;
    var hayProd  = d.estadoGlobal === 'en_produccion' || t.finalizadas > 0;
    var todoFin  = t.unidades > 0 && t.finalizadas === t.unidades;
    var et = [
      { t:'Cotización',  v: t.cotizaciones + (t.cotizaciones===1?' cotización':' cotizaciones'), cls: 'ok' },
      { t:'Aprobación',  v: hayAprob ? t.aprobadas+' aprobada'+(t.aprobadas>1?'s':'') : 'pendiente', cls: hayAprob?'ok':'' },
      { t:'Programación',v: t.unidades ? nUnidades(t.unidades)+' en cola' : 'sin programar', cls: t.unidades?'ok':'' },
      { t:'Producción',  v: todoFin ? 'finalizada' : (hayProd ? 'en curso' : 'pendiente'), cls: todoFin?'ok':(hayProd?'act':'') },
      { t:'Remisión',    v: 'módulo pendiente', cls:'futuro' },
      { t:'Facturación', v: 'módulo pendiente', cls:'futuro' },
    ];
    return '<div class="hv-etapas">'+et.map(function(e){
      return '<div class="hv-etapa '+e.cls+'"><div class="t">'+esc(e.t)+'</div><div class="v">'+esc(e.v)+'</div></div>';
    }).join('')+'</div>';
  }

  function unidadHtml(u) {
    var s = SECCION[u.seccion] || {txt:u.seccion,cls:'back'};
    var txt = (u.enProduccion && u.seccion === 'cola') ? 'En producción' : s.txt;
    var cls = (u.enProduccion && u.seccion === 'cola') ? 'prod' : s.cls;
    var nombre = u.esEnvio ? ('Envío '+u.envioIdx+'/'+u.enviosTotal) : 'Completo';
    var fechas;
    if (u.seccion === 'finalizada') {
      fechas = 'Real: ' + (u.fechaRealInicio ? fechaCorta(u.fechaRealInicio)+' → ' : '') + fechaCorta(u.fechaReal) +
               (u.diasReales ? ' ('+u.diasReales+' d)' : '');
    } else if (u.seccion === 'backlog') {
      fechas = 'sin programar';
    } else {
      fechas = fechaCorta(u.inicio)+' → '+fechaCorta(u.fin);
    }
    return '<div class="hv-uni">'+
      '<span class="badge '+cls+'">'+esc(txt)+'</span>'+
      '<span class="n">'+esc(nombre)+'</span>'+
      '<span class="f">'+esc(fechas)+'</span>'+
      (u.fechaEntrega ? '<span class="f">· entrega '+esc(fechaCorta(u.fechaEntrega))+'</span>' : '')+
      (u.atrasado ? '<span class="badge atr">Atrasado</span>' : '')+
      '<span class="f" style="margin-left:auto;">'+fmtNum(u.mlTotal,0)+' ML</span>'+
      (u.notaEnvio ? '<div class="hv-nota" style="flex-basis:100%;">📝 '+esc(u.notaEnvio)+'</div>' : '')+
    '</div>';
  }

  function render(d) {
    var t = d.totales;
    var titulo = d.nombres.length ? d.nombres.join(' · ') : 'CB'+d.cb;
    var html =
      '<div class="hv-head">'+
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">'+
          '<div>'+
            '<div class="hv-cb">CB'+esc(d.cb)+'</div>'+
            '<div class="hv-title">'+esc(titulo)+
              '<span class="hv-estado '+esc(d.estadoGlobal)+'">'+esc(ESTADO_TXT[d.estadoGlobal]||d.estadoGlobal)+'</span>'+
            '</div>'+
            '<div class="hv-sub">'+(d.cliente?'Cliente '+esc(d.cliente)+' · ':'')+
              t.cotizaciones+(t.cotizaciones===1?' cotización':' cotizaciones')+' · '+
              d.carpetas.length+(d.carpetas.length===1?' carpeta':' carpetas')+' de producción</div>'+
          '</div>'+
          '<a href="cotizaciones.html" class="btn btn-ghost btn-sm">← Cotizaciones</a>'+
        '</div>'+
        etapasHtml(d)+
      '</div>'+

      '<div class="hv-cards">'+
        '<div class="hv-card"><div class="label">ML aprobados</div><div class="value">'+fmtNum(t.mlAprobado,0)+'</div>'+
          '<div class="sub">de '+fmtNum(t.mlCotizado,0)+' cotizados</div></div>'+
        '<div class="hv-card" style="border-left-color:var(--cf-success,#16A34A);"><div class="label">ML producidos</div>'+
          '<div class="value">'+fmtNum(t.mlProducido,0)+'</div><div class="sub">archivos EP2 en Drive</div></div>'+
        '<div class="hv-card" style="border-left-color:#7C3AED;"><div class="label">Unidades</div>'+
          '<div class="value">'+t.unidades+'</div><div class="sub">'+t.finalizadas+' finalizadas</div></div>'+
        '<div class="hv-card" style="border-left-color:#D97706;"><div class="label">Valor aprobado</div>'+
          '<div class="value" style="font-size:1.1rem;">'+fmtMoney(t.valorAprobado)+'</div><div class="sub">subtotal sin IVA</div></div>'+
      '</div>'+

      '<div class="hv-sec"><h3>Cotizaciones del proyecto ('+t.cotizaciones+')</h3>'+
        d.cotizaciones.map(function(c){
          return '<div class="hv-cot">'+
            '<div class="hv-cot-top">'+
              '<span class="hv-cot-nom">'+esc(c.proyecto||'(sin nombre)')+'</span>'+
              '<span class="'+(c.aprobada?'pill-aprob':'pill-noaprob')+'">'+(c.aprobada?'Aprobada':'No aprobada')+'</span>'+
              (c.version?'<span style="font-size:0.7rem;color:var(--cf-gray-text);">v'+esc(c.version)+'</span>':'')+
              '<span style="margin-left:auto;font-size:0.74rem;color:var(--cf-gray-text);">'+esc(fechaCorta(c.fecha))+'</span>'+
            '</div>'+
            '<div class="hv-cot-meta">'+nUnidades(c.cantidad)+' · '+fmtNum(c.mlTotal,0)+' ML · '+fmtMoney(c.subtotal)+' c/u'+
              (c.vinculadas?' · 🔗'+c.vinculadas+' carpeta'+(c.vinculadas>1?'s':''):' · sin carpeta vinculada')+'</div>'+
            (c.notas?'<div class="hv-nota">📝 '+esc(c.notas)+'</div>':'')+
            (c.unidades.length ? c.unidades.map(unidadHtml).join('') : '')+
          '</div>';
        }).join('')+
      '</div>'+

      '<div class="hv-sec"><h3>Carpetas de producción ('+d.carpetas.length+')</h3>'+
        (d.carpetas.length ? d.carpetas.map(function(k){
          return '<div class="hv-uni">'+
            '<span class="n">'+esc(k.nombre)+'</span>'+
            '<span class="f">'+esc(fechaCorta(k.fecha))+' · '+esc(k.estado)+'</span>'+
            '<span class="f" style="margin-left:auto;">'+fmtNum(k.metrosTotal,1)+' ML</span>'+
            '<a class="btn btn-ghost btn-sm" style="font-size:0.72rem;padding:3px 8px;min-height:0;" target="_blank" rel="noopener" '+
              'href="https://drive.google.com/drive/folders/'+esc(k.carpetaId)+'">Drive</a>'+
          '</div>';
        }).join('') : '<div style="font-size:0.8rem;color:var(--cf-gray-text);">Aún no hay carpetas de producción vinculadas a este proyecto.</div>')+
      '</div>';

    document.getElementById('hvBody').innerHTML = html;
  }

  function init() {
    document.getElementById('modNav').classList.remove('hidden');
    document.getElementById('logoutBtn').addEventListener('click', function(){ clearSession(); location.href='index.html'; });

    var cb = new URLSearchParams(location.search).get('cb');
    if (!cb) {
      document.getElementById('hvBody').innerHTML =
        '<div class="hv-sec"><h3>Hoja de vida</h3><p style="font-size:0.85rem;color:var(--cf-gray-text);margin:0;">'+
        'Abre la hoja de vida de un proyecto desde Cotizaciones o Programación.</p></div>';
      return;
    }
    apiProyectoHojaVida(token, cb).then(render).catch(function(e){
      if (e && e.tipo === 'auth') { clearSession(); location.href='index.html'; return; }
      document.getElementById('hvBody').innerHTML =
        '<div class="hv-sec"><p style="color:var(--cf-error);font-weight:600;margin:0;">'+esc((e&&e.message)||'Error al cargar')+'</p></div>';
      toast((e&&e.message)||'Error al cargar','error');
    });
  }
  init();
})();
