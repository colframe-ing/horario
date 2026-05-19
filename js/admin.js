// ============================================================
// admin.js — Lógica del panel de administración
// ============================================================

(function () {
  const session = getSession();
  if (!session || !session.token || !session.esAdmin) {
    window.location.replace('index.html');
    return;
  }

  const { token } = session;
  let horariosList   = [];
  let horarioMap     = {};   // nombre → { inicio, fin }
  let operariosCache = [];   // { cedula, nombre } de operarios activos
  let operarioEditar = null;
  let progCargada    = false;

  // Carga horarios y lista de operarios al inicio
  (async function initData() {
    try {
      const [resHor, resOp] = await Promise.all([
        apiAdminHorariosList(token),
        apiAdminOperariosList(token),
      ]);
      if (resHor.ok) {
        horariosList = resHor.horarios || [];
        horariosList.forEach(h => { horarioMap[h.nombre] = h; });
        poblarSelectHorario(document.getElementById('opHorario'), horariosList);
      }
      if (resOp.ok) {
        operariosCache = (resOp.operarios || []).filter(o => o.activo);
        poblarFiltrosOperario();
      }
    } catch (e) { console.error('initData', e); }
  })();

  // ── Logout ──
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    if (await confirmar({ titulo: 'Cerrar sesión', mensaje: '¿Estás seguro que deseas cerrar sesión?', btnOk: 'Cerrar sesión' })) {
      clearSession(); window.location.replace('index.html');
    }
  });

  // ── Tabs ──
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      // Carga lazy de programación y sesiones abiertas
      if (btn.dataset.tab === 'programacion' && !progCargada) cargarProgramacion();
      if (btn.dataset.tab === 'operarios') cargarSesionesAbiertas();
    });
  });

  // ============================================================
  // TAB: REGISTROS
  // ============================================================

  const btnCargarRegistros = document.getElementById('btnCargarRegistros');
  const bodyRegistros      = document.getElementById('bodyRegistros');
  let registrosData = [];

  btnCargarRegistros.addEventListener('click', cargarRegistros);

  // Default range: current month
  (function setDefaultDates() {
    const hoy   = new Date();
    const inicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    document.getElementById('regDesde').value = fmtDate(inicio);
    document.getElementById('regHasta').value = fmtDate(hoy);
    document.getElementById('heDesde').value  = fmtDate(inicio);
    document.getElementById('heHasta').value  = fmtDate(hoy);
    document.getElementById('asDesde').value  = fmtDate(inicio);
    document.getElementById('asHasta').value  = fmtDate(hoy);
  })();

  async function cargarRegistros() {
    const desde = document.getElementById('regDesde').value;
    const hasta = document.getElementById('regHasta').value;
    btnCargarRegistros.disabled = true;
    btnCargarRegistros.textContent = 'Buscando...';
    try {
      const res = await apiAdminReporte(token, desde, hasta);
      registrosData = res.registros || [];
      renderRegistros(registrosData);
    } catch (e) { manejarError(e, 'cargarRegistros'); }
    finally {
      btnCargarRegistros.disabled = false;
      btnCargarRegistros.textContent = 'Buscar';
    }
  }

  function renderRegistros(rows) {
    const filtro = document.getElementById('filtroOpReg').value;
    const rowsFil = filtro ? rows.filter(r => String(r.cedula) === filtro) : rows;
    const entradas = rowsFil.filter(r => r.tipo === 'ENTRADA').length;
    const salidas  = rowsFil.filter(r => r.tipo === 'SALIDA').length;
    document.getElementById('sumTotal').textContent    = rowsFil.length;
    document.getElementById('sumEntradas').textContent = entradas;
    document.getElementById('sumSalidas').textContent  = salidas;

    if (!rowsFil.length) {
      bodyRegistros.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--cf-gray-text);padding:32px;">Sin registros para el período seleccionado</td></tr>';
      return;
    }
    bodyRegistros.innerHTML = rowsFil.map(r => {
      const porAdmin = r.marcadoPor && r.marcadoPor !== 'OPERARIO';
      const adminBadge = porAdmin
        ? '<span style="font-size:0.65rem;background:#EDE9FE;color:#7C3AED;border-radius:4px;padding:1px 5px;margin-left:4px;font-weight:700;">ADMIN</span>'
        : '';
      // Timestamp escapado para uso en atributo HTML (no contiene ' ni caracteres peligrosos)
      const tsAttr = (r.timestamp || '').replace(/'/g, '');
      return `
      <tr>
        <td><strong>${esc(r.nombre)}</strong>${adminBadge}</td>
        <td style="color:var(--cf-gray-text);">${esc(String(r.cedula))}</td>
        <td><span class="badge badge-${(r.tipo === 'ENTRADA' ? 'entrada' : 'salida')}">${esc(r.tipo)}</span></td>
        <td>${esc(r.fecha)}</td>
        <td style="font-weight:700;">${fmtHora(r.hora)}</td>
        <td style="text-align:right;">
          ${r.timestamp ? `<button class="btn btn-ghost btn-sm" style="color:#DC2626;border-color:#FECACA;padding:3px 8px;font-size:0.72rem;" onclick="eliminarRegistro('${tsAttr}')">🗑</button>` : ''}
        </td>
      </tr>`;
    }).join('');
  }

  document.getElementById('btnExportReg').addEventListener('click', () => {
    const filtro = document.getElementById('filtroOpReg').value;
    const data = filtro ? registrosData.filter(r => String(r.cedula) === filtro) : registrosData;
    exportCSV(data, ['nombre','cedula','tipo','fecha','hora'], 'registros');
  });
  document.getElementById('filtroOpReg').addEventListener('change', () => {
    if (registrosData.length) renderRegistros(registrosData);
  });

  // ============================================================
  // TAB: HORAS EXTRA
  // ============================================================

  const btnCargarHE = document.getElementById('btnCargarHE');
  const bodyHE      = document.getElementById('bodyHE');
  let heData = [];

  btnCargarHE.addEventListener('click', cargarHorasExtra);

  async function cargarHorasExtra() {
    const desde = document.getElementById('heDesde').value;
    const hasta = document.getElementById('heHasta').value;
    btnCargarHE.disabled = true;
    btnCargarHE.textContent = 'Buscando...';
    try {
      const res = await apiAdminHorasExtra(token, desde, hasta);
      heData = res.registros || [];
      renderHorasExtra(heData);
    } catch (e) { manejarError(e, 'cargarHorasExtra'); }
    finally {
      btnCargarHE.disabled = false;
      btnCargarHE.textContent = 'Buscar';
    }
  }

  function renderHorasExtra(rows) {
    const filtroHE = document.getElementById('filtroOpHE').value;
    const rows2 = filtroHE ? rows.filter(r => String(r.cedula) === filtroHE) : rows;
    let totalH = 0, hed = 0, hen = 0, df = 0;
    rows2.forEach(r => {
      const h = parseFloat(r.horas) || 0;
      totalH += h;
      if (r.tipo && r.tipo.includes('Diurna') && !r.tipo.includes('Dominical')) hed += h;
      else if (r.tipo && r.tipo.includes('Nocturna') && !r.tipo.includes('Dominical')) hen += h;
      else df += h;
    });

    document.getElementById('sumHorasTotal').textContent = totalH.toFixed(1) + 'h';
    document.getElementById('sumHED').textContent        = hed.toFixed(1) + 'h';
    document.getElementById('sumHEN').textContent        = hen.toFixed(1) + 'h';
    document.getElementById('sumDF').textContent         = df.toFixed(1) + 'h';

    if (!rows2.length) {
      bodyHE.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--cf-gray-text);padding:32px;">Sin horas extra para el período seleccionado</td></tr>';
      return;
    }
    bodyHE.innerHTML = rows2.map(r => `
      <tr>
        <td><strong>${esc(r.nombre)}</strong></td>
        <td>${esc(r.fecha)}</td>
        <td>${fmtHora(r.horaEnt)}</td>
        <td>${fmtHora(r.horaSal)}</td>
        <td>${fmtHorario(r.horario)}</td>
        <td style="font-weight:800;color:var(--cf-dark);">${parseFloat(r.horas).toFixed(2)}h</td>
        <td style="font-size:0.8rem;">${esc(r.tipo)}</td>
        <td style="font-weight:700;color:var(--cf-blue);">+${esc(r.porcentaje)}</td>
      </tr>`).join('');
  }

  document.getElementById('btnExportHE').addEventListener('click', () => {
    const filtroHE = document.getElementById('filtroOpHE').value;
    const data = filtroHE ? heData.filter(r => String(r.cedula) === filtroHE) : heData;
    exportCSV(data, ['nombre','cedula','fecha','horaEnt','horaSal','horario','horas','tipo','porcentaje'], 'horas-extra');
  });
  document.getElementById('filtroOpHE').addEventListener('change', () => {
    if (heData.length) renderHorasExtra(heData);
  });

  // ============================================================
  // TAB: PROGRAMACIÓN SEMANAL
  // ============================================================

  const DIAS_CORTO  = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
  const MESES_CORTO = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

  let semanaActual = lunesDe(new Date()); // Date: lunes de la semana actual
  let progDatos    = { programacion: [], sesiones: [], operarios: [] };

  function lunesDe(fecha) {
    const d   = new Date(fecha);
    const dia = d.getDay();
    d.setDate(d.getDate() - (dia === 0 ? 6 : dia - 1));
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function diasDeSemana(lunes) {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(lunes);
      d.setDate(lunes.getDate() + i);
      return d;
    });
  }

  function actualizarLabelSemana(dias) {
    const d0 = dias[0], d6 = dias[6];
    document.getElementById('semanaLabel').textContent =
      `${d0.getDate()} ${MESES_CORTO[d0.getMonth()]} – ${d6.getDate()} ${MESES_CORTO[d6.getMonth()]} ${d6.getFullYear()}`;
    document.getElementById('semanaNum').textContent =
      'Semana ' + isoWeek(fmtDate(d0));
  }

  document.getElementById('btnSemAnt').addEventListener('click', () => {
    semanaActual.setDate(semanaActual.getDate() - 7);
    cargarProgramacion();
  });
  document.getElementById('btnSemSig').addEventListener('click', () => {
    semanaActual.setDate(semanaActual.getDate() + 7);
    cargarProgramacion();
  });
  document.getElementById('btnSemHoy').addEventListener('click', () => {
    semanaActual = lunesDe(new Date());
    cargarProgramacion();
  });

  document.getElementById('btnLimpiarSemana').addEventListener('click', async () => {
    const dias  = diasDeSemana(semanaActual);
    const desde = fmtDate(dias[0]);
    const hasta = fmtDate(dias[6]);
    const btn   = document.getElementById('btnLimpiarSemana');

    const ok = await confirmar({
      titulo:  'Limpiar semana',
      mensaje: `¿Eliminar toda la programación de la semana ${desde} al ${hasta}?\n\nEsta acción borra los turnos de todos los operarios para esos días. Las novedades (incapacidades, permisos, etc.) no se eliminan.`,
      btnOk:   'Sí, limpiar',
      peligro: true,
    });
    if (!ok) return;

    btn.disabled = true;
    btn.textContent = 'Limpiando...';
    try {
      const res = await apiAdminLimpiarSemana(token, desde, hasta);
      await cargarProgramacion();
      if (res.eliminadas === 0) {
        toast('La semana ya estaba vacía. No había turnos que eliminar.', 'info');
      } else {
        toast(`Se eliminaron ${res.eliminadas} turno${res.eliminadas !== 1 ? 's' : ''} de la semana.`, 'success');
      }
    } catch (e) { manejarError(e, 'limpiarSemana'); }
    finally {
      btn.disabled = false;
      btn.textContent = '🗑 Limpiar semana';
    }
  });

  document.getElementById('btnPoblarSemana').addEventListener('click', async () => {
    const dias  = diasDeSemana(semanaActual);
    const desde = fmtDate(dias[0]);  // lunes
    const hasta = fmtDate(dias[5]);  // sábado (omite domingo por defecto)
    const btn   = document.getElementById('btnPoblarSemana');

    const ok = await confirmar({
      titulo: 'Aplicar predeterminados',
      mensaje: 'Se asignará el horario predeterminado a cada operario en los días vacíos de la semana. Los turnos ya existentes no serán modificados. ¿Continuar?',
      btnOk: 'Continuar',
    });
    if (!ok) return;

    const incDom = await confirmar({
      titulo:     '¿Incluir el domingo?',
      mensaje:    'Por defecto se programa de Lunes a Sábado. Puedes incluir también el domingo.',
      btnOk:      'Incluir domingo',
      btnCancel:  'Solo Lun–Sáb',
    });
    const hastaFinal = incDom ? fmtDate(dias[6]) : hasta;

    btn.disabled = true;
    btn.textContent = 'Aplicando...';
    try {
      const res = await apiAdminPoblarSemana(token, desde, hastaFinal, incDom);
      const festMsg = res.festivosSaltados ? ` (${res.festivosSaltados} día${res.festivosSaltados !== 1 ? 's' : ''} festivo${res.festivosSaltados !== 1 ? 's' : ''} omitido${res.festivosSaltados !== 1 ? 's' : ''})` : '';
      if (res.creadas === 0) {
        toast('Todos los días ya tienen turno asignado. No se realizaron cambios.' + festMsg, 'info');
      } else {
        await cargarProgramacion();
        toast(`Se asignaron ${res.creadas} turno${res.creadas !== 1 ? 's' : ''} para ${res.operarios} operario${res.operarios !== 1 ? 's' : ''}${festMsg}.`, 'success');
      }
    } catch (e) {
      manejarError(e, 'poblarSemana');
    } finally {
      btn.disabled = false;
      btn.textContent = '✦ Aplicar predeterminados';
    }
  });

  async function cargarProgramacion() {
    const dias  = diasDeSemana(semanaActual);
    const desde = fmtDate(dias[0]);
    const hasta = fmtDate(dias[6]);
    actualizarLabelSemana(dias);

    document.getElementById('bodyProgramacion').innerHTML =
      `<tr><td colspan="9" style="text-align:center;padding:40px;">
        <span class="spinner" style="border-color:rgba(0,0,0,0.1);border-top-color:var(--cf-blue);"></span>
      </td></tr>`;

    try {
      const res = await apiAdminProgramacionGet(token, desde, hasta);
      progDatos  = res;
      progCargada = true;
      renderProgramacion(dias);
    } catch (e) { manejarError(e, 'cargarProgramacion'); }
  }

  function renderProgramacion(dias) {
    const hoy = fmtDate(new Date());

    // Header
    document.getElementById('progHead').innerHTML = `<tr>
      <th style="min-width:130px;position:sticky;left:0;background:#fff;z-index:1;">Operario</th>
      ${dias.map((d, i) => {
        const f = fmtDate(d);
        const esHoy = f === hoy;
        return `<th style="text-align:center;min-width:105px;${esHoy ? 'background:#EFF6FF;color:var(--cf-blue);' : ''}">
          ${DIAS_CORTO[i]}<br>
          <span style="font-weight:${esHoy ? 700 : 400};font-size:0.72rem;">${d.getDate()} ${MESES_CORTO[d.getMonth()]}</span>
        </th>`;
      }).join('')}
      <th style="text-align:center;min-width:90px;">Semana</th>
    </tr>`;

    // Mapas para acceso rápido
    const progMap = {}, sesMap = {}, novMap = {};
    progDatos.programacion.forEach(p => { progMap[p.cedula + '|' + p.fecha] = p; });
    progDatos.sesiones.forEach(s => {
      const k = s.cedula + '|' + s.fecha;
      if (!sesMap[k]) sesMap[k] = [];
      sesMap[k].push(s);
    });
    (progDatos.novedades || []).forEach(n => { novMap[n.cedula + '|' + n.fecha] = n; });

    const operarios = progDatos.operarios;
    if (!operarios.length) {
      document.getElementById('bodyProgramacion').innerHTML =
        '<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--cf-gray-text);">No hay operarios activos</td></tr>';
      return;
    }

    let sumProg = 0, sumTrab = 0, ausencias = 0;

    const filas = operarios.map(op => {
      let opProg = 0, opTrab = 0;

      const celdas = dias.map(dia => {
        const fecha   = fmtDate(dia);
        const esFuturo = fecha > hoy;
        const esHoy   = fecha === hoy;
        const prog    = progMap[op.cedula + '|' + fecha];
        const sess    = sesMap[op.cedula + '|' + fecha] || [];
        const nov     = novMap[op.cedula + '|' + fecha] || null;
        const trabH   = sess.reduce((s, r) => s + (r.horas || 0), 0);
        const tard    = sess.some(r => r.tardanzaMin > 0);
        // Horas justificadas: null en novedad = cubre todo el turno
        const novH    = nov ? (nov.horas != null ? nov.horas : (prog ? prog.horas : 8)) : 0;

        if (prog) { opProg += prog.horas; sumProg += prog.horas; }
        opTrab += trabH; sumTrab += trabH;

        // Solo es "ausencia sin justificar" si no hay novedad
        if (prog && !esFuturo && !esHoy && trabH === 0 && !nov) ausencias++;

        return celdaTurno(op, fecha, prog, nov, novH, trabH, tard, esFuturo, esHoy);
      });

      // Calcular novedades del operario en la semana para el déficit
      const novOpTotal = dias.reduce((acc, dia) => {
        const fecha = fmtDate(dia);
        const nov   = novMap[op.cedula + '|' + fecha];
        const prog  = progMap[op.cedula + '|' + fecha];
        if (!nov) return acc;
        return acc + (nov.horas != null ? nov.horas : (prog ? prog.horas : 8));
      }, 0);
      const deficit  = opTrab + novOpTotal - opProg;
      const defColor = deficit >= 0 ? '#16A34A' : '#DC2626';
      const defLabel = opProg === 0 && opTrab === 0 && novOpTotal === 0
        ? '<span style="color:var(--cf-gray-text);font-size:0.7rem;">sin prog.</span>'
        : deficit >= 0
          ? `<span style="color:#16A34A;font-size:0.7rem;font-weight:700;">✓ ${opTrab.toFixed(1)}h</span>`
          : `<span style="color:#DC2626;font-size:0.7rem;font-weight:700;">${deficit.toFixed(1)}h</span>`;

      return `<tr>
        <td style="font-weight:600;font-size:0.85rem;position:sticky;left:0;background:#fff;z-index:1;border-right:1px solid #E2E8F0;">
          ${esc(op.nombre)}<br>${defLabel}
        </td>
        ${celdas.join('')}
        <td style="text-align:center;font-size:0.82rem;color:var(--cf-dark);">
          <strong>${opTrab.toFixed(1)}h</strong>
          <span style="color:var(--cf-gray-text);"> / ${opProg.toFixed(1)}h</span>
        </td>
      </tr>`;
    });

    document.getElementById('bodyProgramacion').innerHTML = filas.join('');

    // Summary cards
    const deficit = sumTrab - sumProg;
    document.getElementById('progHorasProg').textContent = sumProg.toFixed(1) + 'h';
    document.getElementById('progHorasTrab').textContent = sumTrab.toFixed(1) + 'h';
    const defEl = document.getElementById('progDeficit');
    defEl.textContent = (deficit >= 0 ? '+' : '') + deficit.toFixed(1) + 'h';
    defEl.style.color = deficit >= 0 ? '#16A34A' : '#DC2626';
    document.getElementById('progAusencias').textContent = ausencias;
  }

  // Colores y etiquetas por tipo de novedad
  const NOV_STYLE = {
    'Incapacidad médica':      { bg:'#F5F3FF', color:'#7C3AED', icono:'🏥' },
    'Día de la familia':       { bg:'#F0FDF4', color:'#059669', icono:'🏠' },
    'Vacaciones':              { bg:'#EFF6FF', color:'#2563EB', icono:'🌴' },
    'Licencia remunerada':     { bg:'#F0FDFA', color:'#0D9488', icono:'📋' },
    'Licencia no remunerada':  { bg:'#F9FAFB', color:'#6B7280', icono:'📋' },
    'Permiso — Votación':      { bg:'#FFFBEB', color:'#D97706', icono:'🗳️' },
    'Permiso — Otro':          { bg:'#FFFBEB', color:'#D97706', icono:'🗳️' },
    'Calamidad doméstica':     { bg:'#FFF7ED', color:'#EA580C', icono:'🚨' },
    'Suspensión disciplinaria':{ bg:'#FEF2F2', color:'#991B1B', icono:'⛔' },
  };

  function celdaTurno(op, fecha, prog, nov, novH, trabH, tard, esFuturo, esHoy) {
    let bg = '#F9FAFB', contenido = `<span style="color:#CBD5E1;font-size:1.2rem;">+</span>`;

    // Badge de novedad (siempre visible si existe)
    let novBadge = '';
    if (nov) {
      const ns = NOV_STYLE[nov.tipo] || { bg:'#F9FAFB', color:'#6B7280', icono:'📌' };
      const hLabel = nov.horas != null ? ` ${nov.horas}h` : ' día';
      novBadge = `<div style="font-size:0.6rem;font-weight:700;color:${ns.color};margin-top:2px;line-height:1.2;">
        ${ns.icono}${hLabel}</div>`;
    }

    if (prog) {
      bg = '#EFF6FF';
      let estado = '';
      if (!esFuturo) {
        const justificado = trabH + novH >= (prog.horas - 0.25);
        if (trabH > 0) {
          const ok = trabH >= (prog.horas - 0.25);
          bg = ok ? '#F0FDF4' : (nov ? '#F5F3FF' : '#FFFBEB');
          estado = ok
            ? `<div style="color:#16A34A;font-size:0.68rem;font-weight:700;margin-top:1px;">✓ ${trabH.toFixed(1)}h</div>`
            : `<div style="color:#D97706;font-size:0.68rem;font-weight:700;margin-top:1px;">⚠ ${trabH.toFixed(1)}h</div>`;
          if (tard) estado += `<div style="color:#D97706;font-size:0.6rem;">tarde</div>`;
        } else if (!esHoy) {
          if (nov) {
            const ns = NOV_STYLE[nov.tipo] || { bg:'#F5F3FF', color:'#7C3AED' };
            bg = ns.bg;
            estado = `<div style="color:${ns.color};font-size:0.68rem;font-weight:700;margin-top:1px;">Justificado</div>`;
          } else {
            bg = '#FEF2F2';
            estado = `<div style="color:#DC2626;font-size:0.68rem;font-weight:700;margin-top:1px;">✗ Ausente</div>`;
          }
        }
      }
      contenido = `
        <div style="font-size:0.78rem;font-weight:700;color:var(--cf-dark);line-height:1.3;">${prog.horaInicio}–${prog.horaFin}</div>
        <div style="color:var(--cf-gray-text);font-size:0.65rem;">${prog.horas.toFixed(1)}h</div>
        ${estado}${novBadge}`;
    } else if (nov) {
      // Novedad sin turno programado
      const ns = NOV_STYLE[nov.tipo] || { bg:'#F5F3FF', color:'#7C3AED', icono:'📌' };
      bg = ns.bg;
      contenido = `<div style="font-size:0.7rem;font-weight:700;color:${ns.color};line-height:1.4;">${ns.icono}<br>${esc(nov.tipo.split(' — ')[0])}</div>`;
    } else if (trabH > 0) {
      bg = '#FFFBEB';
      contenido = `<div style="color:#D97706;font-size:0.75rem;font-weight:700;">Sin prog.<br>${trabH.toFixed(1)}h</div>`;
    }

    const opJson  = JSON.stringify({ cedula: op.cedula, nombre: op.nombre }).replace(/"/g, '&quot;');
    const novJson = JSON.stringify(nov || null).replace(/"/g, '&quot;');
    const iniVal  = prog ? prog.horaInicio : '';
    const finVal  = prog ? prog.horaFin    : '';
    return `<td style="padding:3px;">
      <div onclick="editarTurno(${opJson},'${fecha}','${iniVal}','${finVal}',${novJson})"
           style="background:${bg};border-radius:7px;padding:5px 4px;text-align:center;
                  cursor:pointer;min-height:58px;display:flex;flex-direction:column;
                  align-items:center;justify-content:center;transition:filter 0.1s;"
           onmouseenter="this.style.filter='brightness(0.95)'"
           onmouseleave="this.style.filter=''">
        ${contenido}
      </div>
    </td>`;
  }

  // ── Modal turno ──
  let turnoEditando = null;
  const modalTurno     = document.getElementById('modalTurno');
  const turnoAlert     = document.getElementById('turnoAlert');
  const turnoInicioEl  = document.getElementById('turnoInicio');
  const turnoFinEl     = document.getElementById('turnoFin');
  const turnoHorasCalc = document.getElementById('turnoHorasCalc');

  function actualizarCalcHoras() {
    const ini = turnoInicioEl.value, fin = turnoFinEl.value;
    if (!ini || !fin) { turnoHorasCalc.textContent = ''; return; }
    const [h1, m1] = ini.split(':').map(Number);
    const [h2, m2] = fin.split(':').map(Number);
    let min = (h2 * 60 + m2) - (h1 * 60 + m1);
    if (min < 0) min += 1440;
    turnoHorasCalc.textContent = `Duración: ${(min / 60).toFixed(1)} horas`;
  }

  turnoInicioEl.addEventListener('change', () => { document.getElementById('turnoPreset').value = ''; actualizarCalcHoras(); });
  turnoFinEl.addEventListener('change',   () => { document.getElementById('turnoPreset').value = ''; actualizarCalcHoras(); });

  document.getElementById('novedadTipo').addEventListener('change', (e) => {
    const ext = document.getElementById('novedadExtras');
    if (e.target.value) {
      ext.classList.remove('hidden');
      ext.style.display = 'flex';
    } else {
      ext.classList.add('hidden');
      ext.style.display = 'none';
    }
  });

  document.getElementById('turnoPreset').addEventListener('change', (e) => {
    if (!e.target.value) return;
    const [ini, fin] = e.target.value.split('|');
    turnoInicioEl.value = ini;
    turnoFinEl.value    = fin;
    actualizarCalcHoras();
  });

  window.editarTurno = (op, fecha, horaInicio, horaFin, novExistente) => {
    turnoEditando = { ...op, fecha };
    const d = new Date(fecha + 'T00:00:00');
    const fechaLabel = DIAS_CORTO[(d.getDay() + 6) % 7] + ' ' +
      d.getDate() + ' ' + MESES_CORTO[d.getMonth()] + ' ' + d.getFullYear();
    const tieneturno = !!(horaInicio && horaFin);

    // Título y botón Guardar según si es creación o edición
    document.getElementById('modalTurnoTitle').textContent =
      (tieneturno ? 'Editar turno' : 'Nuevo turno') + ' — ' + fechaLabel;
    document.getElementById('turnoSaveText').textContent =
      tieneturno ? 'Guardar cambios' : 'Agregar turno';

    // "Quitar turno" solo tiene sentido si ya existe un turno
    document.getElementById('btnTurnoLibre').style.display = tieneturno ? '' : 'none';

    document.getElementById('turnoInfo').innerHTML = `<strong>${esc(op.nombre)}</strong>`;

    const sel = document.getElementById('turnoPreset');
    sel.innerHTML = '<option value="">— Personalizado —</option>';
    horariosList.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h.inicio + '|' + h.fin;
      opt.textContent = h.nombre + ' (' + h.inicio + '–' + h.fin + ')';
      sel.appendChild(opt);
    });

    turnoInicioEl.value = horaInicio || '';
    turnoFinEl.value    = horaFin    || '';
    actualizarCalcHoras();

    // Cargar novedad existente
    const novTipo  = document.getElementById('novedadTipo');
    const novDesc  = document.getElementById('novedadDesc');
    const novHoras = document.getElementById('novedadHoras');
    const novExtra = document.getElementById('novedadExtras');
    novTipo.value  = novExistente ? novExistente.tipo : '';
    novDesc.value  = novExistente ? (novExistente.descripcion || '') : '';
    novHoras.value = novExistente && novExistente.horas != null ? novExistente.horas : '';
    novExtra.classList.toggle('hidden', !novExistente || !novExistente.tipo);
    novExtra.style.display = (novExistente && novExistente.tipo) ? 'flex' : 'none';

    turnoAlert.classList.add('hidden');
    modalTurno.classList.remove('hidden');
  };

  function cerrarModalTurno() { modalTurno.classList.add('hidden'); turnoEditando = null; }

  document.getElementById('modalTurnoClose').addEventListener('click', cerrarModalTurno);
  document.getElementById('btnTurnoCancel').addEventListener('click', cerrarModalTurno);
  modalTurno.addEventListener('click', e => { if (e.target === modalTurno) cerrarModalTurno(); });

  document.getElementById('btnTurnoLibre').addEventListener('click', async () => {
    if (!turnoEditando) return;
    if (!await confirmar({ titulo: 'Quitar turno', mensaje: `¿Quitar el turno de ${turnoEditando.nombre} del ${turnoEditando.fecha}? Esta acción no se puede deshacer.`, btnOk: 'Sí, quitar', peligro: true })) return;
    await guardarTurno('', '');
  });

  document.getElementById('btnTurnoSave').addEventListener('click', async () => {
    const ini = turnoInicioEl.value, fin = turnoFinEl.value;
    if (!ini || !fin) {
      turnoAlert.textContent = 'Ingresa la hora de inicio y fin';
      turnoAlert.className = 'alert alert-error';
      turnoAlert.classList.remove('hidden');
      return;
    }
    await guardarTurno(ini, fin);
  });

  async function guardarTurno(horaInicio, horaFin) {
    if (!turnoEditando) return;
    const saveText  = document.getElementById('turnoSaveText');
    const saveLoad  = document.getElementById('turnoSaveLoad');
    const saveBtn   = document.getElementById('btnTurnoSave');
    const novTipo   = document.getElementById('novedadTipo').value;
    const novDesc   = document.getElementById('novedadDesc').value.trim();
    const novHStr   = document.getElementById('novedadHoras').value;
    const novH      = novHStr !== '' ? parseFloat(novHStr) : '';

    saveText.classList.add('hidden');
    saveLoad.classList.remove('hidden');
    saveBtn.disabled = true;
    turnoAlert.classList.add('hidden');
    try {
      // Guardar turno y novedad en paralelo
      const promesas = [
        apiAdminProgramacionSet(
          token, turnoEditando.cedula, turnoEditando.nombre,
          turnoEditando.fecha, horaInicio, horaFin
        ),
        apiAdminNovedadSet(
          token, turnoEditando.cedula, turnoEditando.nombre,
          turnoEditando.fecha, novTipo, novDesc, novH
        ),
      ];
      await Promise.all(promesas);
      cerrarModalTurno();
      await cargarProgramacion();
    } catch (e) {
      const msg = (e && e.name === 'ApiError') ? e.message : 'Error de conexión. Intenta de nuevo.';
      turnoAlert.textContent = msg;
      turnoAlert.className = 'alert alert-error';
      turnoAlert.classList.remove('hidden');
      console.error('guardarTurno', e);
    } finally {
      saveText.classList.remove('hidden');
      saveLoad.classList.add('hidden');
      saveBtn.disabled = false;
    }
  }

  // ============================================================
  // TAB: ASISTENCIA
  // ============================================================

  const btnCargarAsistencia = document.getElementById('btnCargarAsistencia');
  const bodyAsistencia      = document.getElementById('bodyAsistencia');
  const asistenciaHead      = document.getElementById('asistenciaHead');
  let asistenciaData = [];

  btnCargarAsistencia.addEventListener('click', cargarAsistencia);

  async function cargarAsistencia() {
    const desde = document.getElementById('asDesde').value;
    const hasta = document.getElementById('asHasta').value;
    btnCargarAsistencia.disabled = true;
    btnCargarAsistencia.textContent = 'Buscando...';
    try {
      const res = await apiAdminAsistencia(token, desde, hasta);
      asistenciaData = res.sesiones || [];
      renderAsistencia(asistenciaData);
    } catch (e) { manejarError(e, 'cargarAsistencia'); }
    finally {
      btnCargarAsistencia.disabled = false;
      btnCargarAsistencia.textContent = 'Buscar';
    }
  }

  document.getElementById('asVista').addEventListener('change', () => {
    if (asistenciaData.length) renderAsistencia(asistenciaData);
  });
  document.getElementById('filtroOpAs').addEventListener('change', () => {
    if (asistenciaData.length) renderAsistencia(asistenciaData);
  });

  function renderAsistencia(rows) {
    const filtroAs = document.getElementById('filtroOpAs').value;
    const rowsAs = filtroAs ? rows.filter(r => String(r.cedula) === filtroAs) : rows;

    const totalHoras   = rowsAs.reduce((s, r) => s + (r.horas || 0), 0);
    const tardanzas    = rowsAs.filter(r => r.tardanzaMin > 0).length;
    const promedio     = rowsAs.length ? totalHoras / rowsAs.length : 0;

    document.getElementById('asSumHoras').textContent = totalHoras.toFixed(1) + 'h';

    const vista = document.getElementById('asVista').value;
    if (vista === 'semana') {
      const semanasUnicas = new Set(rowsAs.map(r => isoWeek(r.fecha))).size;
      const diasUnicos    = new Set(rowsAs.map(r => r.fecha)).size;
      document.getElementById('asSumSesionesLabel').textContent = 'Semanas';
      document.getElementById('asSumPromedioLabel').textContent = 'Días trabajados';
      document.getElementById('asSumSesiones').textContent  = semanasUnicas;
      document.getElementById('asSumTardanzas').textContent = tardanzas;
      document.getElementById('asSumPromedio').textContent  = diasUnicos;
      renderAsistenciaSemana(rowsAs);
    } else {
      document.getElementById('asSumSesionesLabel').textContent = 'Sesiones';
      document.getElementById('asSumPromedioLabel').textContent = 'Prom. horas/sesión';
      document.getElementById('asSumSesiones').textContent  = rowsAs.length;
      document.getElementById('asSumTardanzas').textContent = tardanzas;
      document.getElementById('asSumPromedio').textContent  = promedio.toFixed(1) + 'h';
      renderAsistenciaDetalle(rowsAs);
    }
  }

  function renderAsistenciaDetalle(rows) {
    document.getElementById('asTituloTabla').textContent = 'Detalle por sesión';
    asistenciaHead.innerHTML = `<tr>
      <th>Nombre</th><th>Fecha</th><th>Entrada</th><th>Salida</th>
      <th>Horas</th><th>Tardanza</th><th>Horario</th>
    </tr>`;
    if (!rows.length) {
      bodyAsistencia.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--cf-gray-text);padding:32px;">Sin sesiones para el período seleccionado</td></tr>';
      return;
    }
    bodyAsistencia.innerHTML = rows.map(r => {
      const tarde = r.tardanzaMin > 0;
      const rowStyle = tarde ? 'background:#FFF7ED;' : '';
      const tardLabel = tarde
        ? `<span style="color:#D97706;font-weight:700;">+${r.tardanzaMin} min</span>`
        : '<span style="color:var(--cf-gray-text);">—</span>';
      return `<tr style="${rowStyle}">
        <td><strong>${esc(r.nombre)}</strong></td>
        <td>${esc(r.fecha)}</td>
        <td style="font-weight:700;">${fmtHora(r.horaEnt)}</td>
        <td style="font-weight:700;">${fmtHora(r.horaSal)}</td>
        <td style="font-weight:800;color:var(--cf-dark);">${(r.horas||0).toFixed(2)}h</td>
        <td>${tardLabel}</td>
        <td>${fmtHorario(r.horario)}</td>
      </tr>`;
    }).join('');
  }

  function renderAsistenciaSemana(rows) {
    document.getElementById('asTituloTabla').textContent = 'Resumen por semana';
    asistenciaHead.innerHTML = `<tr>
      <th>Nombre</th><th>Semana</th><th>Días trab.</th>
      <th>Horas totales</th><th>Tardanzas</th>
    </tr>`;
    if (!rows.length) {
      bodyAsistencia.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--cf-gray-text);padding:32px;">Sin sesiones para el período seleccionado</td></tr>';
      return;
    }

    // Agrupar por operario + semana ISO
    const grupos = {};
    rows.forEach(r => {
      const sem   = isoWeek(r.fecha);
      const key   = r.cedula + '|' + sem;
      if (!grupos[key]) grupos[key] = { nombre: r.nombre, cedula: r.cedula, semana: sem, sesiones: [] };
      grupos[key].sesiones.push(r);
    });

    const filas = Object.values(grupos).sort((a, b) =>
      a.semana.localeCompare(b.semana) || a.nombre.localeCompare(b.nombre)
    );

    bodyAsistencia.innerHTML = filas.map(g => {
      const horas     = g.sesiones.reduce((s, r) => s + (r.horas || 0), 0);
      const tardes    = g.sesiones.filter(r => r.tardanzaMin > 0).length;
      const diasUnicos = [...new Set(g.sesiones.map(r => r.fecha))].length;
      const rowStyle  = tardes > 0 ? 'background:#FFF7ED;' : '';
      const tardeLabel = tardes > 0
        ? `<span style="color:#D97706;font-weight:700;">${tardes}</span>`
        : '<span style="color:var(--cf-gray-text);">0</span>';
      return `<tr style="${rowStyle}">
        <td><strong>${esc(g.nombre)}</strong></td>
        <td style="font-size:0.85rem;color:var(--cf-gray-text);">${esc(g.semana)}</td>
        <td style="font-weight:700;">${diasUnicos}</td>
        <td style="font-weight:800;color:var(--cf-dark);">${horas.toFixed(1)}h</td>
        <td>${tardeLabel}</td>
      </tr>`;
    }).join('');
  }

  function isoWeek(dateStr) {
    const d    = new Date(dateStr + 'T00:00:00');
    const thu  = new Date(d);
    thu.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3); // Jueves de la semana ISO
    const jan4 = new Date(thu.getFullYear(), 0, 4);
    const wk   = 1 + Math.round((thu - jan4) / 604800000);
    return thu.getFullYear() + '-S' + String(wk).padStart(2, '0');
  }

  document.getElementById('btnExportAs').addEventListener('click', () => {
    const vista = document.getElementById('asVista').value;
    if (vista === 'semana') {
      // Exportar resumen semanal
      const grupos = {};
      asistenciaData.forEach(r => {
        const sem = isoWeek(r.fecha);
        const key = r.cedula + '|' + sem;
        if (!grupos[key]) grupos[key] = { nombre: r.nombre, cedula: r.cedula, semana: sem, horas: 0, dias: new Set(), tardanzas: 0 };
        grupos[key].horas += r.horas || 0;
        grupos[key].dias.add(r.fecha);
        if (r.tardanzaMin > 0) grupos[key].tardanzas++;
      });
      const flat = Object.values(grupos).map(g => ({
        nombre: g.nombre, cedula: g.cedula, semana: g.semana,
        diasTrabajados: g.dias.size, horasTotales: g.horas.toFixed(2), tardanzas: g.tardanzas,
      }));
      exportCSV(flat, ['nombre','cedula','semana','diasTrabajados','horasTotales','tardanzas'], 'asistencia-semana');
    } else {
      exportCSV(asistenciaData, ['nombre','cedula','fecha','horaEnt','horaSal','horas','tardanzaMin','horario'], 'asistencia-detalle');
    }
  });

  // ============================================================
  // TAB: OPERARIOS
  // ============================================================

  let sesionesAbiertasData = [];   // se rellena en cargarSesionesAbiertas()

  async function cargarOperarios() {
    try {
      const resOp = await apiAdminOperariosList(token);
      renderOperarios(resOp.operarios || []);
    } catch (e) { manejarError(e, 'cargarOperarios'); }
  }

  function renderOperarios(operarios) {
    document.getElementById('operariosCount').textContent = operarios.length + ' operarios';
    const body = document.getElementById('bodyOperarios');
    if (!operarios.length) {
      body.innerHTML = '<tr><td colspan="6"><div class="empty-state"><p>No hay operarios. Agrega el primero.</p></div></td></tr>';
      return;
    }
    body.innerHTML = operarios.map(op => {
      const opJson = JSON.stringify(op).replace(/"/g,'&quot;');
      const bloqueadoBadge = op.bloqueado
        ? '<span class="badge badge-inactive" style="margin-left:6px;font-size:0.65rem;background:#FEF2F2;color:#DC2626;border:1px solid #FECACA;">BLOQUEADO</span>'
        : '';
      const adminBadge = op.esAdmin
        ? '<span class="badge badge-active" style="margin-left:6px;font-size:0.65rem;">ADMIN</span>'
        : '';
      const btnDesbloquear = op.bloqueado
        ? `<button class="btn btn-ghost btn-sm" style="color:#DC2626;border-color:#FECACA;" onclick="desbloquearOperario(${opJson})">Desbloquear</button>`
        : '';
      return `
      <tr>
        <td>
          <strong>${esc(op.nombre)}</strong>${adminBadge}${bloqueadoBadge}
        </td>
        <td style="color:var(--cf-gray-text);">${esc(String(op.cedula))}</td>
        <td>${esc(op.cargo || '—')}</td>
        <td>${fmtHorario(op.horario)}</td>
        <td><span class="badge ${op.activo ? 'badge-active' : 'badge-inactive'}">${op.activo ? 'Activo' : 'Inactivo'}</span></td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" onclick="abrirEditar(${opJson})">Editar</button>
          <button class="btn btn-primary btn-sm" style="background:var(--cf-dark);border-color:var(--cf-dark);" onclick="abrirMarcar(${opJson})">Asistencia</button>
          <button class="btn btn-ghost btn-sm" onclick="abrirReporte(${opJson})">Reporte</button>
          ${btnDesbloquear}
        </td>
      </tr>`;
    }).join('');
  }

  function poblarFiltrosOperario() {
    ['filtroOpReg', 'filtroOpAs', 'filtroOpHE'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const actual = sel.value;
      sel.innerHTML = '<option value="">Todos los operarios</option>';
      operariosCache.forEach(op => {
        const opt = document.createElement('option');
        opt.value = String(op.cedula);
        opt.textContent = op.nombre;
        sel.appendChild(opt);
      });
      if (actual) sel.value = actual;
    });
  }

  function poblarSelectHorario(sel, horarios) {
    const current = sel.value;
    sel.innerHTML = '<option value="">Sin asignar</option>';
    horarios.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h.nombre;
      opt.textContent = h.nombre + ' (' + h.inicio + '–' + h.fin + ')';
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
  }

  cargarOperarios();
  // sesionesAbiertasData se carga al hacer clic en el tab Operarios (lazy)

  // ── Modal operario ──
  const modal        = document.getElementById('modalOperario');
  const formOperario = document.getElementById('formOperario');
  const modalTitle   = document.getElementById('modalTitle');
  const modalError   = document.getElementById('modalError');

  function abrirModal(operario) {
    operarioEditar = operario || null;
    modalTitle.textContent = operario ? 'Editar operario' : 'Nuevo operario';
    document.getElementById('opFila').value   = operario ? operario.fila : '';
    document.getElementById('opNombre').value = operario ? operario.nombre : '';
    document.getElementById('opCedula').value = operario ? operario.cedula : '';
    document.getElementById('opPin').value    = '';
    document.getElementById('opCargo').value  = operario ? (operario.cargo || '') : '';
    document.getElementById('opEmail').value  = operario ? (operario.email || '') : '';
    document.getElementById('opActivo').checked = operario ? operario.activo : true;
    document.getElementById('opAdmin').checked  = operario ? operario.esAdmin : false;
    poblarSelectHorario(document.getElementById('opHorario'), horariosList);
    document.getElementById('opHorario').value = operario ? (operario.horario || '') : '';
    modalError.classList.add('hidden');
    actualizarLabelPin();
    // Email solo visible para admins
    const esAdminActual = operario ? operario.esAdmin : false;
    document.getElementById('opEmailGroup').style.display = esAdminActual ? '' : 'none';
    modal.classList.remove('hidden');
    document.getElementById('opNombre').focus();
  }

  function cerrarModal() { modal.classList.add('hidden'); operarioEditar = null; }

  // Actualizar longitud de PIN y visibilidad del email cuando cambia el checkbox de admin
  document.getElementById('opAdmin').addEventListener('change', (e) => {
    actualizarLabelPin();
    document.getElementById('opEmailGroup').style.display = e.target.checked ? '' : 'none';
  });

  // También actualizar label al abrir modal (en abrirModal se setea el checkbox)
  function actualizarLabelPin() {
    const esAdmin  = document.getElementById('opAdmin').checked;
    const longitud = esAdmin ? 6 : 4;
    const pinEl    = document.getElementById('opPin');
    pinEl.maxLength = longitud;
    document.getElementById('opPinLongitud').textContent = longitud + ' dígitos';
    // Placeholder contextual: nuevo operario vs. editar
    pinEl.placeholder = operarioEditar
      ? 'Dejar en blanco para no cambiar'
      : `Obligatorio — ${longitud} dígitos`;
  }

  window.abrirEditar = (op) => abrirModal(op);

  // ── Marcar por operario ──
  let operarioMarcar = null;
  const modalMarcar        = document.getElementById('modalMarcar');
  const marcarAlert        = document.getElementById('marcarAlert');
  const marcarBtnText      = document.getElementById('marcarBtnText');
  const marcarBtnLoading   = document.getElementById('marcarBtnLoading');
  const btnMarcarConfirm   = document.getElementById('btnMarcarConfirm');

  function abrirModalMarcar(op) {
    operarioMarcar = op;
    const inicial = op.nombre.trim()[0] || '?';
    document.getElementById('marcarAvatar').textContent  = inicial.toUpperCase();
    document.getElementById('marcarNombre').textContent  = op.nombre;
    document.getElementById('marcarCedula').textContent  = 'Cédula: ' + op.cedula;

    // Pre-fill fecha y hora con el momento actual
    const ahora = new Date();
    document.getElementById('marcarFecha').value = fmtDate(ahora);
    document.getElementById('marcarHora').value  =
      String(ahora.getHours()).padStart(2, '0') + ':' + String(ahora.getMinutes()).padStart(2, '0');

    // Inferir el estado desde sesionesAbiertasData si ya fue cargado
    const sesionAbierta = sesionesAbiertasData.find(s => String(s.cedula) === String(op.cedula));
    let estadoHtml;
    if (sesionAbierta) {
      estadoHtml = `Tiene sesión <strong>abierta</strong> desde las ${esc(sesionAbierta.hora.slice(0,5))} del ${esc(sesionAbierta.fecha)}. Se registrará <strong style="color:#DC2626;">SALIDA</strong>.`;
    } else if (sesionesAbiertasData.length > 0 || sesionesAbiertasData._loaded) {
      estadoHtml = `Sin sesión activa. Se registrará <strong style="color:#16A34A;">ENTRADA</strong>.`;
    } else {
      estadoHtml = `El sistema registrará <strong>Entrada</strong> o <strong>Salida</strong> automáticamente según el último registro del operario.`;
    }
    document.getElementById('marcarEstado').innerHTML = estadoHtml +
      ' <span style="color:var(--cf-gray-text);font-size:0.78rem;">Ajusta la fecha/hora si el operario olvidó marcar a tiempo.</span>';

    marcarAlert.classList.add('hidden');
    marcarBtnText.classList.remove('hidden');
    marcarBtnLoading.classList.add('hidden');
    btnMarcarConfirm.disabled = false;
    modalMarcar.classList.remove('hidden');
  }

  function cerrarModalMarcar() {
    modalMarcar.classList.add('hidden');
    operarioMarcar = null;
  }

  window.abrirMarcar = (op) => abrirModalMarcar(op);

  document.getElementById('modalMarcarClose').addEventListener('click', cerrarModalMarcar);
  document.getElementById('btnMarcarCancel').addEventListener('click', cerrarModalMarcar);
  modalMarcar.addEventListener('click', (e) => { if (e.target === modalMarcar) cerrarModalMarcar(); });

  btnMarcarConfirm.addEventListener('click', async () => {
    if (!operarioMarcar) return;
    marcarAlert.classList.add('hidden');
    marcarBtnText.classList.add('hidden');
    marcarBtnLoading.classList.remove('hidden');
    btnMarcarConfirm.disabled = true;

    const fechaOverride = document.getElementById('marcarFecha').value;
    const horaOverride  = document.getElementById('marcarHora').value;

    try {
      const res = await apiAdminMarcarPorOperario(token, operarioMarcar.cedula, fechaOverride, horaOverride);
      cerrarModalMarcar();
      const horaMsg = res.horaAjustada
        ? ` (hora ajustada: ${horaOverride} del ${fechaOverride})`
        : '';
      toast(`${res.nombre}: ${res.tipo} registrada a las ${String(res.hora).slice(0,5)} del ${res.fecha}${horaMsg}`, 'success');
      await cargarOperarios();
      cargarSesionesAbiertas();
    } catch (e) {
      const msg = (e && e.name === 'ApiError') ? e.message : 'Error de conexión. Intenta de nuevo.';
      marcarAlert.textContent = msg;
      marcarAlert.className = 'alert alert-error';
      marcarAlert.classList.remove('hidden');
      console.error('marcarPorOperario', e);
    } finally {
      marcarBtnText.classList.remove('hidden');
      marcarBtnLoading.classList.add('hidden');
      btnMarcarConfirm.disabled = false;
    }
  });

  // ── Desbloquear operario ──
  window.desbloquearOperario = async (op) => {
    if (!await confirmar({ titulo: 'Desbloquear operario', mensaje: `¿Desbloquear la cuenta de ${op.nombre}? El operario podrá volver a iniciar sesión.`, btnOk: 'Desbloquear' })) return;
    try {
      await apiAdminDesbloquear(token, op.cedula);
      toast(`Cuenta de ${op.nombre} desbloqueada correctamente.`, 'success');
      await cargarOperarios();
    } catch (e) { manejarError(e, 'desbloquearOperario'); }
  };

  // ── Modal reporte PDF ──
  let operarioParaReporte = null;
  const modalReporte = document.getElementById('modalReporte');

  window.abrirReporte = (op) => {
    operarioParaReporte = op;
    document.getElementById('reporteOperarioInfo').innerHTML =
      '<strong>' + esc(op.nombre) + '</strong> &nbsp;·&nbsp; Cédula: ' + esc(String(op.cedula));
    const ahora = new Date();
    document.getElementById('reporteMes').value =
      ahora.getFullYear() + '-' + String(ahora.getMonth() + 1).padStart(2, '0');
    modalReporte.classList.remove('hidden');
  };

  function cerrarModalReporte() { modalReporte.classList.add('hidden'); operarioParaReporte = null; }
  document.getElementById('modalReporteClose').addEventListener('click', cerrarModalReporte);
  document.getElementById('btnReporteCancel').addEventListener('click', cerrarModalReporte);
  modalReporte.addEventListener('click', e => { if (e.target === modalReporte) cerrarModalReporte(); });

  document.getElementById('btnReporteGenerar').addEventListener('click', async () => {
    if (!operarioParaReporte) return;
    const mes = document.getElementById('reporteMes').value;
    if (!mes) { toast('Selecciona un mes', 'warning'); return; }
    const btnText    = document.getElementById('reporteBtnText');
    const btnLoading = document.getElementById('reporteBtnLoading');
    const btn        = document.getElementById('btnReporteGenerar');
    btn.disabled = true;
    btnText.classList.add('hidden');
    btnLoading.classList.remove('hidden');
    try {
      const res = await apiAdminReportePdf(token, operarioParaReporte.cedula, mes);
      descargarPdfBase64(res.pdf, res.filename);
      cerrarModalReporte();
      toast('Reporte descargado: ' + res.filename, 'success');
    } catch (e) { manejarError(e, 'reportePdf'); }
    finally {
      btn.disabled = false;
      btnText.classList.remove('hidden');
      btnLoading.classList.add('hidden');
    }
  });

  function descargarPdfBase64(base64, nombre) {
    const bin   = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = nombre; a.click();
    URL.revokeObjectURL(url);
  }

  document.getElementById('btnNuevoOperario').addEventListener('click', () => abrirModal(null));
  document.getElementById('modalClose').addEventListener('click', cerrarModal);
  document.getElementById('btnModalCancel').addEventListener('click', cerrarModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) cerrarModal(); });

  formOperario.addEventListener('submit', async (e) => {
    e.preventDefault();
    modalError.classList.add('hidden');

    const nombre  = document.getElementById('opNombre').value.trim();
    const cedula  = document.getElementById('opCedula').value.trim();
    const pin     = document.getElementById('opPin').value.trim();
    const cargo   = document.getElementById('opCargo').value.trim();
    const horario = document.getElementById('opHorario').value;
    const email   = document.getElementById('opEmail').value.trim();
    const activo  = document.getElementById('opActivo').checked;
    const esAdmin = document.getElementById('opAdmin').checked;
    const fila    = document.getElementById('opFila').value;
    const longitudReq = esAdmin ? 6 : 4;

    if (!nombre || !cedula) {
      modalError.textContent = 'Nombre y cédula son obligatorios';
      modalError.classList.remove('hidden');
      return;
    }
    if (!operarioEditar && !pin) {
      modalError.textContent = 'El PIN es obligatorio para nuevos operarios';
      modalError.classList.remove('hidden');
      return;
    }
    if (pin && (pin.length !== longitudReq || !/^\d+$/.test(pin))) {
      modalError.textContent = `El PIN debe ser exactamente ${longitudReq} dígitos${esAdmin ? ' (administradores requieren 6)' : ''}`;
      modalError.classList.remove('hidden');
      return;
    }

    const saveText = document.querySelector('.btn-save-text');
    const saveLoad = document.querySelector('.btn-save-loading');
    saveText.classList.add('hidden');
    saveLoad.classList.remove('hidden');
    document.getElementById('btnModalSave').disabled = true;

    try {
      const operario = { nombre, cedula, pin, cargo, horario, email, activo, esAdmin };
      if (operarioEditar) {
        await apiAdminOperarioUpdate(token, { ...operario, fila: parseInt(fila) });
      } else {
        await apiAdminOperarioAdd(token, operario);
      }
      cerrarModal();
      await cargarOperarios();
      // Refrescar cache de filtros
      try {
        const resOp = await apiAdminOperariosList(token);
        if (resOp.ok) {
          operariosCache = (resOp.operarios || []).filter(o => o.activo);
          poblarFiltrosOperario();
        }
      } catch { /* silent — no crítico */ }
    } catch (e) {
      const msg = (e && e.name === 'ApiError') ? e.message : 'Error de conexión';
      modalError.textContent = msg;
      modalError.classList.remove('hidden');
      console.error('formOperario', e);
    } finally {
      saveText.classList.remove('hidden');
      saveLoad.classList.add('hidden');
      document.getElementById('btnModalSave').disabled = false;
    }
  });

  // ============================================================
  // TAB: OPERARIOS — Sesiones abiertas
  // ============================================================

  async function cargarSesionesAbiertas() {
    const body = document.getElementById('sesionesAbiertasBody');
    body.innerHTML = '<span style="color:var(--cf-gray-text);font-size:0.82rem;">Cargando...</span>';
    try {
      const res = await apiAdminSesionesAbiertas(token);
      sesionesAbiertasData = res.sesiones || [];
      sesionesAbiertasData._loaded = true; // marca que ya fue consultado
      renderSesionesAbiertas(sesionesAbiertasData);
    } catch (e) {
      body.innerHTML = '<span style="color:#DC2626;font-size:0.82rem;">Error al cargar sesiones abiertas.</span>';
    }
  }

  function renderSesionesAbiertas(sesiones) {
    const body    = document.getElementById('sesionesAbiertasBody');
    const counter = document.getElementById('sesionesCount');
    counter.textContent = sesiones.length;
    counter.style.background = sesiones.length > 0 ? '#FEF9C3' : '#F0FDF4';
    counter.style.color      = sesiones.length > 0 ? '#92400E' : '#15803D';

    if (!sesiones.length) {
      body.innerHTML = '<div style="padding:10px 14px;background:#F0FDF4;border-radius:8px;color:#15803D;font-size:0.82rem;font-weight:600;">✓ Sin sesiones abiertas. Todos los operarios marcaron salida.</div>';
      return;
    }

    const ahora = new Date();
    body.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:10px;">' +
      sesiones.map(s => {
        const entradaDt = new Date(s.fecha + 'T' + (s.hora.length === 5 ? s.hora + ':00' : s.hora));
        const diffMs = ahora - entradaDt;
        const diffH  = Math.max(0, Math.floor(diffMs / 3600000));
        const diffM  = Math.max(0, Math.floor((diffMs % 3600000) / 60000));
        const tiempoLabel = diffH > 0 ? `${diffH}h ${diffM}m` : `${diffM}m`;
        const esLargo = diffH >= 10;
        const bgCard  = esLargo ? '#FEF2F2' : '#FFFBEB';
        const bdCard  = esLargo ? '#FECACA' : '#FDE68A';
        const colorT  = esLargo ? '#DC2626' : '#D97706';
        const bgAv    = esLargo ? '#DC2626' : '#D97706';
        const inicial = esc((s.nombre.trim()[0] || '?').toUpperCase());
        const opJson  = JSON.stringify({ cedula: s.cedula, nombre: s.nombre }).replace(/"/g, '&quot;');
        return `<div style="background:${bgCard};border:1px solid ${bdCard};border-radius:10px;padding:10px 14px;display:flex;align-items:center;gap:12px;min-width:230px;max-width:280px;">
          <div style="width:36px;height:36px;border-radius:50%;background:${bgAv};color:#fff;font-weight:800;font-size:0.9rem;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${inicial}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:0.85rem;color:var(--cf-dark);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(s.nombre)}</div>
            <div style="font-size:0.72rem;color:var(--cf-gray-text);">Entró: ${esc(s.fecha)} ${esc(s.hora.slice(0,5))}</div>
            <div style="font-size:0.75rem;font-weight:700;color:${colorT};">⏱ ${tiempoLabel}${esLargo ? ' ⚠ larga' : ''}</div>
          </div>
          <button class="btn btn-primary btn-sm" style="font-size:0.72rem;padding:5px 10px;background:var(--cf-dark);border-color:var(--cf-dark);flex-shrink:0;" onclick="abrirMarcar(${opJson})">Cerrar</button>
        </div>`;
      }).join('') + '</div>';
  }

  document.getElementById('btnRefreshSesiones').addEventListener('click', cargarSesionesAbiertas);

  // ── Eliminar registro individual ──
  window.eliminarRegistro = async (timestampReg) => {
    // Busca los datos de display en el array ya cargado (evita pasar strings al onclick)
    const r = registrosData.find(x => x.timestamp === timestampReg);
    const nombre = r ? r.nombre : '(operario)';
    const tipo   = r ? r.tipo   : '';
    const fecha  = r ? r.fecha  : '';
    const ok = await confirmar({
      titulo:  'Eliminar registro',
      mensaje: `¿Eliminar la marcación de ${nombre}?\n\nTipo: ${tipo} — Fecha: ${fecha}\n\nEsta acción borrará también la sesión de trabajo y horas extra de ese día. Podrás volver a marcar con la fecha y hora correcta usando "Marcar por operario".`,
      btnOk:   'Sí, eliminar',
      peligro: true,
    });
    if (!ok) return;
    try {
      const res = await apiAdminEliminarRegistro(token, timestampReg);
      toast(`Registro de ${res.nombre} (${res.tipo} del ${res.fecha}) eliminado.`, 'success');
      await cargarRegistros();
    } catch (e) { manejarError(e, 'eliminarRegistro'); }
  };

  // ============================================================
  // TAB: AUDITORÍA
  // ============================================================

  const ACCION_LABEL = {
    OPERARIO_CREADO:      { txt: 'Operario creado',       color: '#16A34A' },
    OPERARIO_ACTUALIZADO: { txt: 'Operario actualizado',  color: '#2563EB' },
    DESBLOQUEO:           { txt: 'Desbloqueo',             color: '#D97706' },
    MARCACION_ADMIN:      { txt: 'Marcación por admin',    color: '#7C3AED' },
    REGISTRO_ELIMINADO:   { txt: 'Registro eliminado',     color: '#DC2626' },
    TURNO_CREADO:         { txt: 'Turno creado',           color: '#16A34A' },
    TURNO_ACTUALIZADO:    { txt: 'Turno actualizado',      color: '#2563EB' },
    TURNO_ELIMINADO:      { txt: 'Turno eliminado',        color: '#DC2626' },
    POBLAR_SEMANA:        { txt: 'Poblar semana',          color: '#0D9488' },
    NOVEDAD_CREADA:       { txt: 'Novedad creada',         color: '#16A34A' },
    NOVEDAD_ACTUALIZADA:  { txt: 'Novedad actualizada',    color: '#2563EB' },
    NOVEDAD_ELIMINADA:    { txt: 'Novedad eliminada',      color: '#DC2626' },
  };

  let audData = [];
  const btnCargarAud = document.getElementById('btnCargarAud');

  // Fechas por defecto
  (function setDefaultDatesAud() {
    const hoy = new Date();
    const hace7 = new Date(hoy);
    hace7.setDate(hoy.getDate() - 7);
    document.getElementById('audDesde').value = fmtDate(hace7);
    document.getElementById('audHasta').value = fmtDate(hoy);
  })();

  btnCargarAud.addEventListener('click', cargarAuditoria);
  document.getElementById('audFiltroAccion').addEventListener('change', () => {
    if (audData.length) renderAuditoria(audData);
  });

  async function cargarAuditoria() {
    const desde = document.getElementById('audDesde').value;
    const hasta = document.getElementById('audHasta').value;
    btnCargarAud.disabled = true;
    btnCargarAud.textContent = 'Buscando...';
    try {
      const res = await apiAdminAuditoriaGet(token, desde, hasta);
      audData = res.eventos || [];
      renderAuditoria(audData);
    } catch (e) { manejarError(e, 'cargarAuditoria'); }
    finally {
      btnCargarAud.disabled = false;
      btnCargarAud.textContent = 'Buscar';
    }
  }

  function renderAuditoria(rows) {
    const filtro = document.getElementById('audFiltroAccion').value;
    let filtradas;
    if (filtro === 'CORRECCIONES_MANUALES') {
      // Filtro virtual: marcaciones admin con hora ajustada manualmente
      filtradas = rows.filter(r => {
        if (r.accion !== 'MARCACION_ADMIN') return false;
        try { return JSON.parse(r.detalle).horaAjustada === true; } catch { return false; }
      });
    } else {
      filtradas = filtro ? rows.filter(r => r.accion === filtro) : rows;
    }

    document.getElementById('audSumTotal').textContent = filtradas.length;
    const adminsUnicos = new Set(filtradas.map(r => r.adminCedula));
    document.getElementById('audSumAdmins').textContent = adminsUnicos.size;

    const body = document.getElementById('bodyAud');
    if (!filtradas.length) {
      body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--cf-gray-text);padding:32px;">Sin eventos para los filtros seleccionados</td></tr>';
      return;
    }

    body.innerHTML = filtradas.map(r => {
      const meta = ACCION_LABEL[r.accion] || { txt: r.accion, color: '#6B7280' };
      const det  = formatDetalle(r.detalle);
      const ts   = formatTimestamp(r.timestamp);
      return `<tr>
        <td style="white-space:nowrap;font-size:0.82rem;">
          <strong>${ts.fecha}</strong><br>
          <span style="color:var(--cf-gray-text);font-size:0.75rem;">${ts.hora}</span>
        </td>
        <td>
          <strong>${esc(r.adminNombre || '—')}</strong><br>
          <span style="color:var(--cf-gray-text);font-size:0.75rem;">${esc(r.adminCedula)}</span>
        </td>
        <td><span style="display:inline-block;padding:3px 8px;border-radius:6px;background:${meta.color}15;color:${meta.color};font-weight:700;font-size:0.75rem;">${meta.txt}</span></td>
        <td style="font-size:0.78rem;line-height:1.5;color:var(--cf-dark);">${det}</td>
      </tr>`;
    }).join('');
  }

  function formatTimestamp(iso) {
    try {
      const d = new Date(iso);
      return {
        fecha: d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Bogota' }),
        hora:  d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Bogota' }),
      };
    } catch { return { fecha: iso, hora: '' }; }
  }

  function formatDetalle(raw) {
    if (!raw) return '<span style="color:var(--cf-gray-text);">—</span>';
    let obj;
    try { obj = JSON.parse(raw); } catch { return esc(String(raw)); }
    // Render legible
    const partes = [];
    Object.keys(obj).forEach(k => {
      const v = obj[k];
      if (v == null || v === '') return;
      if (k === 'previo' && typeof v === 'object') {
        const subpartes = Object.entries(v).map(([sk, sv]) => `${esc(sk)}: ${esc(String(sv))}`).join(', ');
        partes.push(`<span style="color:var(--cf-gray-text);font-size:0.72rem;">antes → ${subpartes}</span>`);
      } else if (typeof v === 'object') {
        const subpartes = Object.entries(v).map(([sk, sv]) => `${esc(sk)}: ${esc(String(sv))}`).join(', ');
        partes.push(`<strong>${esc(k)}:</strong> ${subpartes}`);
      } else {
        partes.push(`<strong>${esc(k)}:</strong> ${esc(String(v))}`);
      }
    });
    return partes.join(' &middot; ');
  }

  document.getElementById('btnExportAud').addEventListener('click', () => {
    const filtro = document.getElementById('audFiltroAccion').value;
    let filtradas;
    if (filtro === 'CORRECCIONES_MANUALES') {
      filtradas = audData.filter(r => {
        if (r.accion !== 'MARCACION_ADMIN') return false;
        try { return JSON.parse(r.detalle).horaAjustada === true; } catch { return false; }
      });
    } else {
      filtradas = filtro ? audData.filter(r => r.accion === filtro) : audData;
    }
    exportCSV(filtradas, ['timestamp','adminCedula','adminNombre','accion','detalle'], 'auditoria');
  });

  // ============================================================
  // UTILS
  // ============================================================

  // ── Modal de confirmación ──
  function confirmar({ titulo = 'Confirmar', mensaje, btnOk = 'Confirmar', btnCancel = 'Cancelar', peligro = false }) {
    return new Promise(resolve => {
      document.getElementById('confirmTitle').textContent = titulo;
      document.getElementById('confirmMsg').textContent   = mensaje;
      const okBtn     = document.getElementById('confirmOk');
      const cancelBtn = document.getElementById('confirmCancel');
      okBtn.textContent     = btnOk;
      cancelBtn.textContent = btnCancel;
      okBtn.className = 'btn btn-sm btn-primary';
      okBtn.style.background  = peligro ? '#DC2626' : '';
      okBtn.style.borderColor = peligro ? '#DC2626' : '';
      const modal = document.getElementById('modalConfirm');
      modal.classList.remove('hidden');
      const cleanup = (val) => {
        modal.classList.add('hidden');
        okBtn.onclick = null;
        cancelBtn.onclick = null;
        cancelBtn.textContent = 'Cancelar'; // restablecer para próximas llamadas
        resolve(val);
      };
      okBtn.onclick     = () => cleanup(true);
      cancelBtn.onclick = () => cleanup(false);
    });
  }

  // ── Manejador unificado de errores ──
  function manejarError(err, contexto) {
    console.error(contexto, err);
    const msg = (err && err.name === 'ApiError') ? err.message : 'Ocurrió un error inesperado.';
    if (err && err.tipo === 'auth') {
      toast(msg + ' Vuelve a iniciar sesión.', 'error', 4000);
      setTimeout(() => { clearSession(); window.location.replace('index.html'); }, 1500);
      return;
    }
    toast(msg, 'error');
  }

  // ── Notificación toast ──
  function toast(mensaje, tipo = 'info', durMs = 3500) {
    const colores = {
      info:    { bg: '#EFF6FF', color: '#1E40AF', borde: '#BFDBFE', icono: 'ℹ' },
      success: { bg: '#F0FDF4', color: '#15803D', borde: '#BBF7D0', icono: '✓' },
      warning: { bg: '#FFFBEB', color: '#A16207', borde: '#FDE68A', icono: '⚠' },
      error:   { bg: '#FEF2F2', color: '#B91C1C', borde: '#FECACA', icono: '✕' },
    };
    const c = colores[tipo] || colores.info;
    const div = document.createElement('div');
    div.style.cssText = `pointer-events:auto;background:${c.bg};color:${c.color};border:1px solid ${c.borde};border-radius:10px;padding:12px 16px;min-width:240px;max-width:360px;box-shadow:0 4px 12px rgba(0,0,0,0.08);font-size:0.88rem;font-weight:600;display:flex;align-items:center;gap:10px;animation:slideIn 0.2s ease;`;
    div.innerHTML = '<span style="font-size:1.1rem;">' + c.icono + '</span><span style="flex:1;">' + esc(mensaje) + '</span>';
    document.getElementById('toastContainer').appendChild(div);
    setTimeout(() => { div.style.opacity = '0'; div.style.transition = 'opacity 0.3s'; }, durMs - 300);
    setTimeout(() => div.remove(), durMs);
  }

  // Convierte cualquier formato de hora a HH:mm legible
  function fmtHora(val) {
    if (!val) return '—';
    const s = String(val);
    // ISO timestamp (ej: 2026-05-18T05:00:00.000Z) → convierte a hora Bogotá
    if (s.length > 8 && (s.includes('T') || s.includes('Z'))) {
      try {
        return new Date(s).toLocaleTimeString('es-CO', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
        });
      } catch { return s.slice(11, 16); }
    }
    return s.slice(0, 5); // HH:mm:ss → HH:mm
  }

  function fmtHorario(nombre) {
    if (!nombre) return '<span style="color:var(--cf-gray-text);">—</span>';
    const h = horarioMap[nombre];
    if (h) {
      return `<span style="line-height:1.5;display:inline-block;">
        <span style="display:block;font-size:0.82rem;font-weight:600;color:var(--cf-dark);">${esc(nombre)}</span>
        <span style="display:block;font-size:0.75rem;font-weight:700;color:var(--cf-blue);letter-spacing:0.02em;">${h.inicio}&thinsp;–&thinsp;${h.fin}</span>
      </span>`;
    }
    return `<span style="font-size:0.82rem;">${esc(nombre)}</span>`;
  }

  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtDate(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2,'0') + '-' +
      String(d.getDate()).padStart(2,'0');
  }

  function exportCSV(data, cols, nombre) {
    if (!data.length) { toast('No hay datos para exportar', 'warning'); return; }
    const header = cols.join(',');
    const rows   = data.map(r => cols.map(c => '"' + String(r[c] || '').replace(/"/g,'""') + '"').join(','));
    const blob   = new Blob(['﻿' + header + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href = url; a.download = 'colframe-' + nombre + '-' + fmtDate(new Date()) + '.csv';
    a.click(); URL.revokeObjectURL(url);
  }
})();
