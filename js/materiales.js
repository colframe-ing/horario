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
  if (!session || !session.token || !puedeOperar(session)) return;   // programacion.js ya redirige
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
   *  otra vez inflaría el aviso con algo que no es de este material. En la
   *  simulación hay una sola "unidad" —el pedido—, y "1 de 1 unidades" no le
   *  dice nada a nadie: ahí va `avisoFijo`. */
  function filaMaterialHtml(m, conDatos, avisoFijo) {
    var aviso = m.noPuedenAportar
      ? '<div class="mat-alerta">⚠ ' + (avisoFijo || (m.noPuedenAportar + ' de ' + conDatos +
        ' unidades con datos no lo pueden decir')) + '</div>' : '';
    return '<tr' + (m.cantidad === 0 ? ' class="cero"' : '') + '>' +
      '<td class="cod">' + esc(m.idProducto) + (m.frecuente ? ' <span class="mat-frec" title="Uno de los ocho más frecuentes">★</span>' : '') + '</td>' +
      '<td>' + esc(m.descripcion) + (m.sinMapeo ? ' <span class="mat-sinmap" title="El código de la plantilla no está en el catálogo">código desconocido</span>' : '') + aviso + '</td>' +
      '<td class="n"><strong>' + (m.cantidad ? fmtNum(m.cantidad) : '—') + '</strong> <span class="und">' + esc(m.unidad) + '</span></td>' +
      '<td class="n">' + (m.pesoKgEstimado != null ? fmtNum(m.pesoKgEstimado, 1) + ' kg' : '<span class="und">sin peso</span>') + '</td>' +
      '<td class="n">' + m.unidadesQueAportan + '</td></tr>';
  }

  /**
   * EL ACERO POR PERFIL. Metros siempre; kg solo donde `CatalogoPerfiles` dice
   * cuánto pesa el metro, y donde no, se nombra el perfil que falta en vez de
   * inventar un peso. El KG del maestro va al lado para comparar: si la suma por
   * perfil se aleja mucho, un factor está mal.
   */
  function aceroHtml(acero, hojaFalta) {
    var a = acero || {};
    var ps = a.perfiles || [];
    var h = '<h4 class="mat-sub">Acero por perfil</h4>';
    if (!ps.length) {
      h += '<div class="mat-cob vacio">Las cotizaciones no traen metros por calibre.' +
        (a.kgMaestro != null ? ' El maestro dice <strong>' + fmtNum(a.kgMaestro, 0) + ' kg</strong> de acero en total.' : '') +
        '</div>';
      return h;
    }
    h += '<div class="mat-tabla-wrap"><table class="mat-tabla"><thead><tr>' +
      '<th>Perfil</th><th>Calibre</th><th class="n">Metros</th><th class="n">kg por metro</th><th class="n">Kg</th>' +
      '</tr></thead><tbody>' + ps.map(function (p) {
        return '<tr' + (p.kg == null ? ' class="cero"' : '') + '><td class="cod">' + esc(p.perfil) + '</td>' +
          '<td>' + (p.calibre ? esc(p.calibre) : '<span class="und">sin calibre</span>') + '</td>' +
          '<td class="n"><strong>' + fmtNum(p.metros, 2) + '</strong> <span class="und">m</span></td>' +
          '<td class="n">' + (p.kgPorMetro != null ? fmtNum(p.kgPorMetro, 3) : '<span class="mat-alerta">falta</span>') + '</td>' +
          '<td class="n">' + (p.kg != null ? '<strong>' + fmtNum(p.kg, 1) + '</strong> kg' : '—') + '</td></tr>';
      }).join('') + '</tbody><tfoot><tr><td colspan="4">' +
        (a.completo ? 'Total por perfil' : 'Total de los perfiles con peso por metro') + '</td>' +
        '<td class="n"><strong>' + (a.kgPorPerfil != null ? fmtNum(a.kgPorPerfil, 1) + ' kg' : '—') + '</strong></td></tr></tfoot></table></div>';
    var notas = [];
    if (hojaFalta) {
      notas.push('Falta la hoja <strong>CatalogoPerfiles</strong> en el libro de logística: ejecuta <code>setupRemisiones()</code>.');
    } else if ((a.sinFactor || []).length) {
      notas.push('Falta cuánto pesa un metro de <strong>' + esc(a.sinFactor.join(', ')) + '</strong>: se llena en la hoja ' +
        '<strong>CatalogoPerfiles</strong> (perfil · calibre · kgPorMetro). Mientras tanto salen solo en metros.' +
        (a.sinFactor.some(function (s) { return /sin calibre$/.test(s); })
          ? ' <em>Sin calibre</em> es el C140 de cotizaciones viejas, que no lo separaban por calibre: en la hoja va con el calibre vacío.'
          : ''));
    }
    if (a.kgMaestro != null) {
      var comp = '';
      if (a.completo && a.kgPorPerfil) {
        var dif = (a.kgPorPerfil - a.kgMaestro) / a.kgMaestro * 100;
        comp = Math.abs(dif) < 0.5 ? ' — cuadra con la suma por perfil.'
          : ' — la suma por perfil da ' + (dif > 0 ? '+' : '−') + fmtNum(Math.abs(dif), 1) + ' %.';
      }
      notas.push('El maestro dice <strong>' + fmtNum(a.kgMaestro, 0) + ' kg</strong> de acero' +
        ((a.sinKgUids || []).length ? ' (sin contar ' + a.sinKgUids.length + (a.sinKgUids.length === 1 ? ' unidad que no trae KG)' : ' unidades que no traen KG)') : '') + comp);
    }
    notas.push('El maestro no separa el acero G350 del G550: eso solo lo dicen los archivos de producción.');
    return h + '<ul class="mat-notas">' + notas.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>';
  }

  /** Cómo se nombra una cotización en el buscador de la simulación. */
  function etiquetaCotiz(c) {
    return 'CB' + (c.consecutivo || '?') + (c.version ? '.' + c.version : '') + ' · ' + (c.proyecto || c.archivo) +
      (c.mlTotal ? ' · ' + fmtNum(c.mlTotal, 0) + ' ML/casa' : '');
  }

  /** Qué cotización eligió quien escribe: la etiqueta exacta, o lo escrito si
   *  lo contiene UNA sola. Dos o más no se adivinan. Devuelve el archivo o ''. */
  function buscarCotiz(texto, lista) {
    var t = String(texto || '').trim().toLowerCase();
    if (!t) return '';
    var exacta = (lista || []).filter(function (c) { return etiquetaCotiz(c).toLowerCase() === t; })[0];
    if (exacta) return exacta.archivo;
    var hits = (lista || []).filter(function (c) { return etiquetaCotiz(c).toLowerCase().indexOf(t) > -1; });
    return hits.length === 1 ? hits[0].archivo : '';
  }

  /** Una fecha de la simulación: "12 oct 2026", o el porqué de no tenerla. */
  function fechaSim(t, cual) {
    if (!t) return '—';
    if (t.demasiadoLargo) return 'más de 13 años';
    var iso = t[cual];
    if (!iso) return '—';
    return fechaCorta(iso) + ' ' + String(iso).substring(0, 4);
  }

  /** EN CUÁNTO TIEMPO: días hábiles al ritmo del Gantt, y dos arranques. */
  function tiempoHtml(tp) {
    var t = tp || {};
    if (!t.desdeHoy) {
      return '<div class="mat-cob mal">No se puede calcular el tiempo: ' +
        (!(t.ml > 0) ? 'la cotización no trae metros lineales.' : 'no hay ritmo de producción configurado.') + '</div>';
    }
    var fila = function (nombre, x) {
      return '<tr><td>' + nombre + '</td><td class="n"><strong>' + fechaSim(x, 'inicio') + '</strong></td>' +
        '<td class="n"><strong>' + fechaSim(x, 'fin') + '</strong></td></tr>';
    };
    var real = t.ritmoReal;
    return '<div class="sim-tiempo"><div class="sim-dias"><strong>' + fmtNum(t.desdeHoy.dias, 0) + ' días hábiles</strong>' +
      ' <span class="und">' + fmtNum(t.ml, 0) + ' ML a ' + fmtNum(t.ritmo, 0) + ' ML por día, el ritmo del Gantt</span></div>' +
      '<table class="mat-tabla"><thead><tr><th>Si arranca…</th><th class="n">Empieza</th><th class="n">Termina</th></tr></thead><tbody>' +
      fila('Hoy, como lo único por producir', t.desdeHoy) +
      fila('Después de la cola actual' + (t.colaTermina ? ' <span class="und">(' + t.unidadesEnCola +
        (t.unidadesEnCola === 1 ? ' unidad, termina el ' : ' unidades, terminan el ') + esc(fechaCorta(t.colaTermina)) + ')</span>' : ''), t.trasCola) +
      '</tbody></table>' +
      (real ? '<div class="und" style="margin-top:6px;">Al ritmo real medido (' + fmtNum(real.ritmo, 0) + ' ML por día, sobre ' +
        real.n + ' unidades terminadas): <strong>' + fmtNum(real.desdeHoy.dias, 0) + ' días hábiles</strong>, hasta el ' +
        fechaSim(real.trasCola, 'fin') + ' después de la cola.</div>' : '') +
      '<ul class="mat-notas"><li>Con el mismo calendario del Gantt: domingos, festivos y excepciones. Una sola máquina.</li>' +
      '<li>Un día empezado es un día ocupado: se redondea hacia arriba.</li></ul></div>';
  }

  /** La simulación completa: qué, cuánto tarda, qué materiales y qué acero. */
  function simulacionHtml(res) {
    var c = res.cotizacion || {}, cob = res.cobertura || {};
    var h = '<div class="sim-titulo"><strong>' + fmtNum(res.casas, 0) + (res.casas === 1 ? ' casa' : ' casas') + '</strong> de ' +
      esc(c.proyecto || c.archivo) + ' <span class="und">CB' + esc(c.cb) + (c.version ? '.' + esc(c.version) : '') +
      ' · ' + fmtNum(c.mlCasa, 0) + ' ML por casa</span></div>';
    h += '<h4 class="mat-sub">En cuánto tiempo</h4>' + tiempoHtml(res.tiempo);
    h += '<h4 class="mat-sub">Accesorios</h4>';
    if (!cob.conDatos) {
      h += '<div class="mat-cob mal">Esta cotización no trae datos de material' +
        (cob.porFuente && cob.porFuente.rota ? ' (su plantilla está dañada)' : '') + ': no hay accesorios que sumar.</div>';
    } else {
      if (cob.respaldo) {
        h += '<div class="mat-cob aviso">Esta cotización usa la plantilla vieja, que solo dice ' + (res.alcanceRespaldo || []).length +
          ' accesorios. Los marcados <span class="mat-alerta">⚠</span> no los dice: pueden faltar.</div>';
      }
      h += '<div class="mat-tabla-wrap"><table class="mat-tabla"><thead><tr>' +
        '<th>Código</th><th>Material</th><th class="n">Cantidad</th><th class="n">Peso estimado</th><th class="n"></th></tr></thead><tbody>' +
        (res.materiales || []).map(function (m) {
          return filaMaterialHtml(Object.assign({}, m, { unidadesQueAportan: '' }), 1, 'la plantilla vieja no lo dice: puede faltar');
        }).join('') + '</tbody></table></div>' +
        '<ul class="mat-notas"><li>Lo que se cuenta va en enteros sobre el pedido completo. Si sale en varios envíos, ' +
        'cada remisión redondea la suya y el total puede subir un poco.</li></ul>';
    }
    return h + aceroHtml(res.acero, res.catalogoPerfilesFalta);
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
   *  en Excel no tiene la pantalla para saber qué quedó por fuera. Sirve para
   *  la ventana y para la simulación; el acero va al final, en su propia tabla. */
  function csvMateriales(res) {
    var c = res.cobertura || {};
    var n = (res.alcanceRespaldo || []).length;
    var cabecera;
    if (res.simulacion) {
      var cot = res.cotizacion || {}, t = res.tiempo || {}, d = t.desdeHoy;
      cabecera = [
        [celdaCsv('Simulación: ' + res.casas + ' casas de ' + (cot.proyecto || cot.archivo) +
                  ' (CB' + cot.cb + (cot.version ? '.' + cot.version : '') + ')')],
        [celdaCsv((d ? d.dias + ' días hábiles a ' + t.ritmo + ' ML por día (' + t.ml + ' ML). Desde hoy: ' +
                      (d.inicio || '') + ' a ' + (d.fin || 'más de 13 años') + '. Después de la cola: ' +
                      ((t.trasCola && t.trasCola.inicio) || '') + ' a ' + ((t.trasCola && t.trasCola.fin) || 'más de 13 años')
                    : 'Sin tiempo: la cotización no trae metros o no hay ritmo configurado.') +
         (c.respaldo ? ' Plantilla vieja: solo ' + n + ' accesorios, los marcados en unidades_que_no_lo_pueden_decir pueden faltar.' : ''))],
      ];
    } else {
      cabecera = [
        [celdaCsv('Materiales para producir del ' + res.desde + ' al ' + res.hasta)],
        [celdaCsv(c.conDatos + ' de ' + c.total + ' unidades con datos de material' +
                  (c.respaldo ? '; ' + c.respaldo + ' de plantilla vieja (solo ' + n +
                                ' accesorios: los que marcan unidades_que_no_lo_pueden_decir pueden quedarse cortos)' : ''))],
      ];
    }
    var out = cabecera.concat([
      [],
      ['codigo', 'descripcion', 'unidad', 'cantidad', 'peso_kg_estimado', 'frecuente',
       'unidades_que_aportan', 'unidades_que_no_lo_pueden_decir', 'codigo_desconocido'].map(celdaCsv),
    ]);
    (res.materiales || []).forEach(function (m) {
      out.push([m.idProducto, m.descripcion, m.unidad, m.cantidad,
                m.pesoKgEstimado == null ? '' : m.pesoKgEstimado,
                m.frecuente ? 'si' : '', m.unidadesQueAportan, m.noPuedenAportar,
                m.sinMapeo ? 'si' : ''].map(celdaCsv));
    });
    // El acero, después: en metros siempre, en kg donde hay peso por metro.
    var ac = res.acero || {};
    if ((ac.perfiles || []).length) {
      out.push([]);
      out.push(['perfil', 'calibre', 'metros', 'kg_por_metro', 'kg'].map(celdaCsv));
      ac.perfiles.forEach(function (p) {
        out.push([p.perfil, p.calibre, p.metros, p.kgPorMetro == null ? '' : p.kgPorMetro,
                  p.kg == null ? '' : p.kg].map(celdaCsv));
      });
      if (ac.kgMaestro != null) out.push([celdaCsv('KG del maestro'), '', '', '', celdaCsv(ac.kgMaestro)]);
    }
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

      h += aceroHtml(res.acero, res.catalogoPerfilesFalta);

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

  function descargar(res, nombre) {
    if (!res) return;
    var blob = new Blob(['﻿' + csvMateriales(res)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = nombre;
    a.click(); URL.revokeObjectURL(url);
  }
  function descargarCsv() {
    if (_res) descargar(_res, 'colframe-materiales-' + _res.desde + '_' + _res.hasta + '.csv');
  }

  // ── Simular un pedido ───────────────────────────────────────────────────
  //
  // "¿Qué materiales necesitaría para 500 casas, y en cuánto tiempo?" Una
  // cotización del maestro como modelo y N casas. No programa ni guarda nada:
  // es la misma cuenta de la ventana, sobre un pedido que no existe todavía.

  var _sim = null;            // última respuesta de prod_materiales_simular
  var _cotizaciones = null;   // la lista del maestro, para el buscador

  function abrirSim() {
    $('modalSimular').classList.remove('hidden');
    $('simBuscar').focus();
    if (_cotizaciones) return;
    $('simCuerpo').innerHTML = '<div class="und" style="padding:8px 0;">Cargando las cotizaciones del maestro…</div>';
    apiCotizList(token).then(function (r) {
      _cotizaciones = (r.cotizaciones || []).filter(function (c) { return c.archivo; });
      $('simOpciones').innerHTML = _cotizaciones.map(function (c) {
        return '<option value="' + esc(etiquetaCotiz(c)) + '"></option>';
      }).join('');
      $('simCuerpo').innerHTML = '';
    }).catch(function (e) {
      if (e && e.tipo === 'auth') { clearSession(); location.href = 'index.html'; return; }
      $('simCuerpo').innerHTML = '<div class="mat-cob mal">' + esc((e && e.message) || 'No se pudieron cargar las cotizaciones') + '</div>';
    });
  }
  function cerrarSim() { $('modalSimular').classList.add('hidden'); }

  function simular() {
    var cuerpo = $('simCuerpo');
    var archivo = buscarCotiz($('simBuscar').value, _cotizaciones);
    if (!archivo) {
      cuerpo.innerHTML = '<div class="mat-cob mal">Elige la cotización modelo de la lista' +
        ($('simBuscar').value.trim() ? ': lo escrito coincide con varias o con ninguna.' : '.') + '</div>';
      return;
    }
    var casas = Number($('simCasas').value);
    if (!(casas >= 1 && casas <= 100000) || Math.floor(casas) !== casas) {
      cuerpo.innerHTML = '<div class="mat-cob mal">La cantidad de casas tiene que ser un número entero entre 1 y 100.000.</div>';
      return;
    }
    var btn = $('simCalcular');
    btn.disabled = true; $('simCsv').disabled = true;
    cuerpo.innerHTML = '<div style="text-align:center;padding:20px;"><span class="spinner" ' +
      'style="border-color:rgba(0,0,0,0.1);border-top-color:var(--cf-blue);"></span></div>';
    apiProdMaterialesSimular(token, archivo, casas)
      .then(function (r) { _sim = r; cuerpo.innerHTML = simulacionHtml(r); $('simCsv').disabled = false; })
      .catch(function (e) {
        if (e && e.tipo === 'auth') { clearSession(); location.href = 'index.html'; return; }
        _sim = null;
        cuerpo.innerHTML = '<div class="mat-cob mal">' + esc((e && e.message) || 'No se pudo simular') + '</div>';
      })
      .finally(function () { btn.disabled = false; });
  }
  function descargarCsvSim() {
    if (_sim) descargar(_sim, 'colframe-simulacion-' + _sim.casas + '-casas-CB' + (_sim.cotizacion || {}).cb + '.csv');
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

    // El botón vive dentro de <summary>: sin esto, además de abrir la
    // simulación, abriría o cerraría la tarjeta.
    $('matSimular').addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); abrirSim(); });
    $('simCalcular').addEventListener('click', simular);
    $('simCsv').addEventListener('click', descargarCsvSim);
    $('simCerrar').addEventListener('click', cerrarSim);
    $('modalSimular').addEventListener('click', function (e) { if (e.target.id === 'modalSimular') cerrarSim(); });
    ['simBuscar', 'simCasas'].forEach(function (id) {
      $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); simular(); } });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('modalSimular').classList.contains('hidden')) cerrarSim();
    });
  }
  init();
})();
