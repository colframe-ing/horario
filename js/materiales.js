// ============================================================
// MATERIALES — qué accesorios hacen falta en una ventana de tiempo
// ============================================================
//
// La tarjeta "Materiales para producir" de programacion.html. PLAN_MATERIALES.md
// §5. Archivo aparte a propósito: programacion.js ya pasa de 1.700 líneas, y esta
// tarjeta no comparte estado con el calendario — solo la página.
//
// Tres partes, en este orden y no en otro:
//   1. La ventana: mes siguiente (el caso que originó esto), este mes, próximos
//      30 días, o un rango libre.
//   2. LA COBERTURA, ARRIBA DE LA TABLA Y NO AL PIE. Un total que ignora en
//      silencio lo que no sabe es peor que no tener el reporte.
//   3. La tabla, de mayor a menor, con los frecuentes marcados — y el CSV,
//      porque quien compra no va a entrar al sistema.
//
// Se carga al ABRIR la tarjeta, no al entrar a la página: lee el maestro de
// cotizaciones entero, y quien viene a mover la cola no tiene por qué pagarlo.
(function () {
  'use strict';

  var session = getSession();
  if (!session || !session.token || !session.esAdmin) return;   // programacion.js ya redirige
  var token = session.token;

  var MESES_COR = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  var FUENTE_TXT = {
    remision_detalle: 'plantilla', accesorios: 'plantilla vieja', rota: 'plantilla dañada',
    ninguna: 'sin datos', sin_maestro: 'no está en el maestro',
  };

  var _res = null;            // última respuesta de prod_materiales_ventana
  var _preset = 'mes_siguiente';
  var _cargada = false;

  // ════════════════════════════════════════════════════════════════════════
  // Funciones puras — `tests/materiales_pantalla.test.js` las extrae por nombre
  // ════════════════════════════════════════════════════════════════════════

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function fmtNum(n,d){ if(n==null||n==='')return '—'; var v=Number(n); if(isNaN(v))return '—'; return v.toLocaleString('es-CO',{minimumFractionDigits:0,maximumFractionDigits:d==null?2:d}); }
  function fechaCorta(iso){ if(!iso)return '—'; var p=String(iso).substring(0,10).split('-'); if(p.length<3)return '—'; return parseInt(p[2],10)+' '+MESES_COR[parseInt(p[1],10)-1]; }

  /** Hoy en Bogotá, YYYY-MM-DD. */
  function hoyBogota() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  }

  /** Una fecha ISO más `n` días de calendario. En UTC, para no depender de la zona. */
  function sumarDias(iso, n) {
    var p = String(iso).substring(0, 10).split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + n * 86400000).toISOString().substring(0, 10);
  }

  /**
   * Las ventanas con atajo: { desde, hasta }.
   *   este_mes       del 1 al último día del mes de hoy
   *   mes_siguiente  el mes calendario que viene — el caso que originó esto
   *   prox30         hoy y los 30 días siguientes
   */
  function ventanaPreset(tipo, hoy) {
    var p = String(hoy).substring(0, 10).split('-');
    var y = +p[0], m = +p[1] - 1;
    var mes = function (yy, mm) {
      var ini = new Date(Date.UTC(yy, mm, 1)), fin = new Date(Date.UTC(yy, mm + 1, 0));
      return { desde: ini.toISOString().substring(0, 10), hasta: fin.toISOString().substring(0, 10) };
    };
    if (tipo === 'este_mes') return mes(y, m);
    if (tipo === 'mes_siguiente') return mes(y, m + 1);   // Date.UTC pasa diciembre → enero solo
    return { desde: String(hoy).substring(0, 10), hasta: sumarDias(hoy, 30) };
  }

  /** "14 de 19" · el nombre de las unidades que no suman, y lo que el respaldo no alcanza. */
  function coberturaHtml(res) {
    var c = res.cobertura || {};
    if (!c.total) {
      return '<div class="mat-cob vacio">Nada de la cola se produce entre el ' + esc(fechaCorta(res.desde)) +
        ' y el ' + esc(fechaCorta(res.hasta)) + '.</div>';
    }
    var h = '';
    if (!c.sinDatos) {
      h += '<div class="mat-cob ok"><strong>Las ' + c.total + ' unidades de la ventana traen datos de material.</strong></div>';
    } else {
      var nombres = (res.unidades || []).filter(function (u) { return (c.sinDatosUids || []).indexOf(u.uid) > -1; })
        .map(function (u) { return u.proyecto + (u.envio ? ' (' + u.envio.toLowerCase() + ')' : ''); });
      h += '<div class="mat-cob mal"><strong>' + c.conDatos + ' de ' + c.total + ' unidades tienen datos de material.</strong> ' +
        (c.sinDatos === 1 ? 'La restante no está contada' : 'Las ' + c.sinDatos + ' restantes no están contadas') +
        ' en los totales de abajo: <em>' + esc(nombres.join(', ')) + '</em>.</div>';
    }
    // La cobertura que el "100 %" esconde: la de cada ítem.
    // El número sale del backend (`alcanceRespaldo`) y no se escribe aquí: si
    // mañana se mapea otra columna, este texto no puede quedarse diciendo siete.
    if (c.respaldo) {
      var n = (res.alcanceRespaldo || []).length;
      h += '<div class="mat-cob aviso">' + (c.respaldo === 1 ? '1 unidad viene' : c.respaldo + ' unidades vienen') +
        ' de cotizaciones con la plantilla vieja, que solo dice ' + n + ' accesorios. Lo demás ' +
        '<strong>no se sabe</strong> para esas unidades: los ítems marcados <span class="mat-alerta">⚠</span> ' +
        'pueden quedarse cortos.</div>';
    }
    return h;
  }

  /** Una fila de la tabla de materiales. `conDatos` es el denominador del
   *  aviso: las unidades SIN datos ya están nombradas arriba, y contarlas aquí
   *  otra vez inflaría el aviso con algo que no es de este material. */
  function filaMaterialHtml(m, conDatos) {
    var aviso = m.noPuedenAportar
      ? '<div class="mat-alerta">⚠ ' + m.noPuedenAportar + ' de ' + conDatos +
        ' unidades con datos no lo pueden decir</div>' : '';
    return '<tr' + (m.cantidad === 0 ? ' class="cero"' : '') + '>' +
      '<td class="cod">' + esc(m.idProducto) + (m.frecuente ? ' <span class="mat-frec" title="Uno de los ocho más frecuentes">★</span>' : '') + '</td>' +
      '<td>' + esc(m.descripcion) + (m.sinMapeo ? ' <span class="mat-sinmap" title="El código de la plantilla no está en el catálogo">código desconocido</span>' : '') + aviso + '</td>' +
      '<td class="n"><strong>' + (m.cantidad ? fmtNum(m.cantidad) : '—') + '</strong> <span class="und">' + esc(m.unidad) + '</span></td>' +
      '<td class="n">' + (m.pesoKgEstimado != null ? fmtNum(m.pesoKgEstimado, 1) + ' kg' : '<span class="und">sin peso</span>') + '</td>' +
      '<td class="n">' + m.unidadesQueAportan + '</td></tr>';
  }

  /** Lo que queda por fuera de la ventana a propósito, con su número. */
  function excluidasTxt(pausadas, sinCola) {
    var p = pausadas ? (pausadas === 1 ? 'la unidad pausada' : 'las ' + pausadas + ' unidades pausadas') : 'las pausadas';
    var s = sinCola ? (sinCola === 1 ? 'la aprobada sin cola' : 'las ' + sinCola + ' aprobadas sin cola') : 'las aprobadas sin cola';
    return 'No cuentan ' + p + ' ni ' + s + ': no tienen fecha que afirmar.';
  }

  /** Una celda de CSV. Lo que empiece por = + - @ se neutraliza: Excel lo
   *  ejecutaría como fórmula (hallazgo R2-11). Los números van tal cual. */
  function celdaCsv(v) {
    if (typeof v === 'number') return String(v);
    var s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  /** El CSV de la tabla, con la ventana y la cobertura arriba: quien lo abre
   *  en Excel no tiene la pantalla para saber qué quedó por fuera. */
  function csvMateriales(res) {
    var c = res.cobertura || {};
    var out = [
      [celdaCsv('Materiales para producir del ' + res.desde + ' al ' + res.hasta)],
      [celdaCsv(c.conDatos + ' de ' + c.total + ' unidades con datos de material' +
                (c.respaldo ? '; ' + c.respaldo + ' de plantilla vieja (solo ' + (res.alcanceRespaldo || []).length +
                              ' accesorios: los que marcan unidades_que_no_lo_pueden_decir pueden quedarse cortos)' : ''))],
      [],
      ['codigo', 'descripcion', 'unidad', 'cantidad', 'peso_kg_estimado', 'frecuente',
       'unidades_que_aportan', 'unidades_que_no_lo_pueden_decir', 'codigo_desconocido'].map(celdaCsv),
    ];
    (res.materiales || []).forEach(function (m) {
      out.push([m.idProducto, m.descripcion, m.unidad, m.cantidad,
                m.pesoKgEstimado == null ? '' : m.pesoKgEstimado,
                m.frecuente ? 'si' : '', m.unidadesQueAportan, m.noPuedenAportar,
                m.sinMapeo ? 'si' : ''].map(celdaCsv));
    });
    return out.map(function (f) { return f.join(','); }).join('\n');
  }

  // ════════════════════════════════════════════════════════════════════════
  // Pantalla
  // ════════════════════════════════════════════════════════════════════════

  function $(id) { return document.getElementById(id); }

  function pintar() {
    var cuerpo = $('matCuerpo');
    var res = _res;
    $('matCsv').disabled = !(res && (res.materiales || []).length);
    if (!res) return;
    var c = res.cobertura || {};
    $('matResumen').textContent = c.total
      ? (res.materiales || []).filter(function (m) { return m.cantidad > 0; }).length + ' ítems · ' + c.total + ' unidades'
      : '';

    var h = coberturaHtml(res);
    if (c.total) {
      h += '<div class="mat-tabla-wrap"><table class="mat-tabla"><thead><tr>' +
        '<th>Código</th><th>Material</th><th class="n">Cantidad</th><th class="n">Peso estimado</th>' +
        '<th class="n" title="Cuántas unidades de la ventana lo piden">Unidades</th></tr></thead><tbody>' +
        (res.materiales || []).map(function (m) { return filaMaterialHtml(m, c.conDatos); }).join('') +
        '</tbody></table></div>';

      h += '<details class="mat-unidades"><summary>Las ' + c.total + ' unidades de la ventana</summary>' +
        '<table class="mat-tabla"><thead><tr><th>Proyecto</th><th>Producción</th><th class="n">ML</th><th>Datos</th></tr></thead><tbody>' +
        (res.unidades || []).map(function (u) {
          return '<tr><td>' + esc(u.proyecto) + (u.envio ? ' <span class="und">' + esc(u.envio) + '</span>' : '') +
            (u.conAvance ? ' <span class="mat-avance" title="Ya tiene avance: se cuenta completa">con avance</span>' : '') + '</td>' +
            '<td>' + esc(fechaCorta(u.inicio)) + ' → ' + esc(fechaCorta(u.fin)) + '</td>' +
            '<td class="n">' + fmtNum(u.mlUnidad, 0) + '</td>' +
            '<td class="fuente ' + esc(u.fuente) + '">' + esc(FUENTE_TXT[u.fuente] || u.fuente) + '</td></tr>';
        }).join('') + '</tbody></table></details>';
    }

    // Las aproximaciones, en la pantalla y no solo en el plan (§6).
    h += '<ul class="mat-notas">' +
      '<li><strong>Por fecha de producción, no de despacho.</strong> El accesorio sale unos días después de que se fabrica el panel, así que esto adelanta la necesidad: el lado seguro para comprar.</li>' +
      '<li><strong>Una unidad con avance cuenta completa.</strong> El sistema no sabe cuántos remaches le faltan a una casa al 60 %; se sobrestima.</li>' +
      '<li><strong>Un envío por metros pide la parte proporcional</strong> de los accesorios del proyecto, igual que al remisionar.</li>' +
      '<li>' + excluidasTxt(res.pausadas, res.sinCola) + '</li>' +
      '</ul>';
    cuerpo.innerHTML = h;
  }

  function marcarPreset() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-mat]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-mat') === _preset));
    });
  }

  function consultar() {
    var desde = $('matDesde').value, hasta = $('matHasta').value;
    var cuerpo = $('matCuerpo');
    if (!desde || !hasta) { cuerpo.innerHTML = '<div class="mat-cob mal">Elige las dos fechas.</div>'; return; }
    // El servidor también lo rechaza; esto es para no hacer el viaje.
    if (desde > hasta) {
      cuerpo.innerHTML = '<div class="mat-cob mal">La fecha inicial es posterior a la final.</div>';
      _res = null; $('matCsv').disabled = true; $('matResumen').textContent = '';
      return;
    }
    var btn = $('matConsultar');
    btn.disabled = true;
    cuerpo.innerHTML = '<div style="text-align:center;padding:20px;"><span class="spinner" ' +
      'style="border-color:rgba(0,0,0,0.1);border-top-color:var(--cf-blue);"></span></div>';
    apiProdMaterialesVentana(token, desde, hasta)
      .then(function (r) { _res = r; _cargada = true; pintar(); })
      .catch(function (e) {
        if (e && e.tipo === 'auth') { clearSession(); location.href = 'index.html'; return; }
        _res = null; pintar();
        cuerpo.innerHTML = '<div class="mat-cob mal">' + esc((e && e.message) || 'No se pudo calcular') + '</div>';
      })
      .finally(function () { btn.disabled = false; });
  }

  function aplicarPreset(tipo) {
    _preset = tipo;
    var v = ventanaPreset(tipo, hoyBogota());
    $('matDesde').value = v.desde;
    $('matHasta').value = v.hasta;
    marcarPreset();
    consultar();
  }

  function descargarCsv() {
    if (!_res) return;
    var blob = new Blob(['﻿' + csvMateriales(_res)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'colframe-materiales-' + _res.desde + '_' + _res.hasta + '.csv';
    a.click(); URL.revokeObjectURL(url);
  }

  function init() {
    var card = $('materialesCard');
    if (!card) return;
    card.addEventListener('toggle', function () { if (card.open && !_cargada) aplicarPreset(_preset); });
    card.addEventListener('click', function (e) {
      var b = e.target.closest('[data-mat]');
      if (b) { e.preventDefault(); aplicarPreset(b.getAttribute('data-mat')); }
    });
    // Tocar una fecha a mano ya no es ningún atajo.
    ['matDesde', 'matHasta'].forEach(function (id) {
      $(id).addEventListener('change', function () { _preset = ''; marcarPreset(); });
    });
    $('matConsultar').addEventListener('click', consultar);
    $('matCsv').addEventListener('click', descargarCsv);
  }
  init();
})();
