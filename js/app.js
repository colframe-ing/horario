// ============================================================
// app.js — Lógica de la página del operario
// ============================================================

(function () {
  function fmtHora(val) {
    if (!val) return '—';
    const s = String(val);
    if (s.length > 8 && (s.includes('T') || s.includes('Z'))) {
      try {
        return new Date(s).toLocaleTimeString('es-CO', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
        });
      } catch { return s.slice(11, 16); }
    }
    return s.slice(0, 5);
  }

  // Guard: redirigir si no hay sesión
  const session = getSession();
  if (!session || !session.token) {
    window.location.replace('index.html');
    return;
  }

  // ── DOM refs ──
  const userAvatar      = document.getElementById('userAvatar');
  const userName        = document.getElementById('userName');
  const userCargo       = document.getElementById('userCargo');
  const markClock       = document.getElementById('markClock');
  const markDate        = document.getElementById('markDate');
  const markStatusLabel = document.getElementById('markStatusLabel');
  const markBtn         = document.getElementById('markBtn');
  const markBtnText     = document.getElementById('markBtnText');
  const markSpinner     = document.getElementById('markSpinner');
  const geoStatus       = document.getElementById('geoStatus');
  const lastMark        = document.getElementById('lastMark');
  const markAlert       = document.getElementById('markAlert');
  const historialCont   = document.getElementById('historialContainer');
  const logoutBtn       = document.getElementById('logoutBtn');

  let estadoActual = null; // { tieneEntradaAbierta, ultimoRegistro }

  // ── Reloj en tiempo real ──
  function actualizarReloj() {
    const ahora = new Date();
    const h = String(ahora.getHours()).padStart(2, '0');
    const m = String(ahora.getMinutes()).padStart(2, '0');
    const s = String(ahora.getSeconds()).padStart(2, '0');
    markClock.textContent = h + ':' + m + ':' + s;

    const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
    const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    markDate.textContent = dias[ahora.getDay()] + ', ' + ahora.getDate() + ' ' + meses[ahora.getMonth()] + ' ' + ahora.getFullYear();
  }
  actualizarReloj();
  setInterval(actualizarReloj, 1000);

  // ── Llenar datos del usuario ──
  userName.textContent  = session.nombre  || 'Operario';
  userCargo.textContent = session.cargo   || session.horario || '';
  userAvatar.textContent = (session.nombre || 'O').charAt(0).toUpperCase();
  logoutBtn.addEventListener('click', async () => {
    if (await appConfirmar('¿Cerrar sesión?', 'Se cerrará tu sesión actual.')) {
      clearSession();
      window.location.replace('index.html');
    }
  });

  // ── Confirmación personalizada (reemplaza confirm() nativo) ──
  function appConfirmar(titulo, mensaje) {
    return new Promise(resolve => {
      const modal     = document.getElementById('appModalConfirm');
      const okBtn     = document.getElementById('appConfirmOk');
      const cancelBtn = document.getElementById('appConfirmCancel');
      document.getElementById('appConfirmTitle').textContent = titulo;
      document.getElementById('appConfirmMsg').textContent   = mensaje;
      modal.style.display = 'flex';
      const cleanup = (val) => {
        modal.style.display = 'none';
        okBtn.onclick = null; cancelBtn.onclick = null;
        resolve(val);
      };
      okBtn.onclick     = () => cleanup(true);
      cancelBtn.onclick = () => cleanup(false);
    });
  }

  // ── Cargar estado inicial ──
  async function cargarEstado() {
    try {
      const res = await apiEstado(session.token);
      estadoActual = res;
      actualizarUI();
      verificarSesionVencida();
    } catch (e) {
      console.error('cargarEstado', e);
      if (e && e.name === 'ApiError' && e.tipo === 'auth') {
        clearSession(); window.location.replace('index.html'); return;
      }
      setGeoStatus('Sin conexión. Refresca la página.', 'error');
    }
  }

  function actualizarUI() {
    if (!estadoActual) return;
    const abierta = estadoActual.tieneEntradaAbierta;

    markStatusLabel.textContent = abierta ? 'Turno en curso' : 'Sin turno activo';

    markBtnText.textContent = abierta ? 'Marcar Salida' : 'Marcar Entrada';
    markBtn.className = 'btn btn-mark btn-full ' + (abierta ? 'btn-salida' : 'btn-primary');
    markBtn.disabled = false;

    const u = estadoActual.ultimoRegistro;
    if (u) {
      lastMark.textContent = 'Último registro: ' + u.tipo + ' el ' + u.fecha + ' a las ' + fmtHora(u.hora);
      lastMark.classList.remove('hidden');
    }
  }

  // ── Marcar entrada / salida ──
  markBtn.addEventListener('click', async () => {
    hideAlert();
    setMarkLoading(true);
    setGeoStatus('Obteniendo ubicación GPS...', '');

    try {
      const { enPlanta, distancia, lat, lng, precision } = await validarEnPlanta();

      if (!enPlanta) {
        setGeoStatus('📍 Estás a ' + distancia + ' m de la planta (máx. ' + CONFIG.RADIO_METROS + ' m)', 'error');
        showAlert('No puedes marcar desde fuera de la planta. Acércate al área de producción.', 'error');
        setMarkLoading(false);
        return;
      }

      setGeoStatus('📍 Ubicación confirmada (' + distancia + ' m de la planta, precisión ±' + precision + ' m)', 'ok');

      const res = await apiMarcar(session.token, lat, lng);
      const emoji = res.tipo === 'ENTRADA' ? '✅' : '🏁';
      showAlert(emoji + ' ' + res.tipo + ' registrada a las ' + res.hora, 'success');
      estadoActual = {
        tieneEntradaAbierta: res.tipo === 'ENTRADA',
        ultimoRegistro: { tipo: res.tipo, fecha: res.fecha, hora: res.hora },
      };
      actualizarUI();
      await cargarHistorial();
    } catch (err) {
      console.error('marcar', err);
      const msg = (err && err.name === 'ApiError') ? err.message : (err.message || 'Error inesperado.');
      showAlert(msg, 'error');
      setGeoStatus('', '');
    } finally {
      setMarkLoading(false);
    }
  });

  function setMarkLoading(v) {
    markBtn.disabled = v;
    markSpinner.classList.toggle('hidden', !v);
    if (v) markBtnText.textContent = 'Un momento...';
    else actualizarUI();
  }

  function setGeoStatus(msg, tipo) {
    geoStatus.textContent = msg;
    geoStatus.style.color = tipo === 'error' ? 'var(--cf-error)' : tipo === 'ok' ? 'var(--cf-success)' : 'var(--cf-gray-text)';
  }

  function showAlert(msg, tipo) {
    markAlert.textContent = msg;
    markAlert.className = 'alert alert-' + tipo;
    markAlert.classList.remove('hidden');
    setTimeout(() => markAlert.classList.add('hidden'), 6000);
  }

  function hideAlert() {
    markAlert.classList.add('hidden');
  }

  // ── Historial ──
  async function cargarHistorial() {
    try {
      const res = await apiHistorial(session.token);
      renderHistorial(res.registros || []);
    } catch (e) {
      console.error('cargarHistorial', e);
      renderHistorial([]);
    }
  }

  function renderHistorial(registros) {
    if (!registros.length) {
      historialCont.innerHTML = '<div class="empty-state"><p>Sin registros aún</p></div>';
      return;
    }

    historialCont.innerHTML = registros.map(r => {
      const esEntrada = r.tipo === 'ENTRADA';
      const icono     = esEntrada ? '↑' : '↓';
      const clase     = esEntrada ? 'entrada' : 'salida';
      const adminNote = r.porAdmin
        ? '<span style="font-size:0.65rem;color:#7C3AED;font-weight:700;margin-left:4px;">·ADMIN</span>'
        : '';
      return `
        <div class="history-item">
          <div class="history-icon ${clase}">${icono}</div>
          <div class="history-info">
            <div class="history-tipo ${esEntrada ? '' : 'badge-salida'}">${esc(r.tipo)}${adminNote}</div>
            <div class="history-fecha">${esc(r.fecha)}</div>
          </div>
          <div class="history-hora">${esc(fmtHora(r.hora))}</div>
        </div>`;
    }).join('');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Sesión vencida ──────────────────────────────────────────
  // Si el operario tiene una ENTRADA de un día anterior sin cerrar,
  // se muestra este modal antes de que pueda marcar cualquier cosa.

  const modalSV     = document.getElementById('modalSesionVencida');
  const svOpciones  = document.getElementById('svOpciones');
  const svForm      = document.getElementById('svForm');
  const svError     = document.getElementById('svError');
  const svGpsMsg    = document.getElementById('svGpsMsg');
  const svBtnConf   = document.getElementById('svBtnConfirmar');

  function hoyEnColombia() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  }

  function verificarSesionVencida() {
    if (!estadoActual || !estadoActual.tieneEntradaAbierta || !estadoActual.ultimoRegistro) return;
    const u = estadoActual.ultimoRegistro;
    if (!u.fecha || u.fecha >= hoyEnColombia()) return; // entrada de hoy → no aplica

    // Poblar labels
    document.getElementById('svFechaLabel').textContent = u.fecha;
    document.getElementById('svHoraLabel').textContent  = (u.hora || '').slice(0, 5);

    // Pre-fill formulario con fecha de la entrada y hora vacía
    document.getElementById('svFechaSalida').value = u.fecha;
    document.getElementById('svFechaSalida').max   = hoyEnColombia();
    document.getElementById('svHoraSalida').value  = '';

    svOpciones.style.display = 'block';
    svForm.style.display     = 'none';
    svError.style.display    = 'none';
    svGpsMsg.style.display   = 'none';
    modalSV.style.display    = 'flex';
    markBtn.disabled         = true; // bloquear marcación normal hasta resolver
  }

  document.getElementById('svOptOlvide').addEventListener('click', () => {
    svOpciones.style.display = 'none';
    svForm.style.display     = 'block';
  });

  document.getElementById('svOptTrabaje').addEventListener('click', () => {
    modalSV.style.display = 'none';
    markBtn.disabled      = false;
    actualizarUI(); // reactiva el botón de salida
  });

  document.getElementById('svBtnAtras').addEventListener('click', () => {
    svForm.style.display     = 'none';
    svOpciones.style.display = 'block';
    svError.style.display    = 'none';
    svGpsMsg.style.display   = 'none';
  });

  svBtnConf.addEventListener('click', async () => {
    const fecha = document.getElementById('svFechaSalida').value;
    const hora  = document.getElementById('svHoraSalida').value;

    svError.style.display  = 'none';
    svGpsMsg.style.display = 'none';

    if (!fecha) { mostrarSvError('Ingresa la fecha de salida.'); return; }
    if (!hora)  { mostrarSvError('Ingresa la hora de salida.'); return; }

    // La salida no puede ser en el futuro
    if (new Date(fecha + 'T' + hora) > new Date()) {
      mostrarSvError('La hora de salida no puede ser en el futuro.'); return;
    }

    // La salida debe ser después de la entrada
    const u = estadoActual.ultimoRegistro;
    if (new Date(fecha + 'T' + hora) <= new Date(u.fecha + 'T' + u.hora)) {
      mostrarSvError('La salida debe ser después de la entrada (' + u.fecha + ' ' + (u.hora || '').slice(0, 5) + ').'); return;
    }

    svBtnConf.disabled    = true;
    svBtnConf.textContent = 'Verificando GPS...';
    svGpsMsg.style.display = 'block';
    svGpsMsg.textContent   = 'Obteniendo ubicación...';

    try {
      const { enPlanta, distancia, lat, lng } = await validarEnPlanta();

      if (!enPlanta) {
        svGpsMsg.style.display = 'none';
        mostrarSvError('📍 Estás a ' + distancia + ' m de la planta (máx. ' + CONFIG.RADIO_METROS + ' m). Debes estar en la planta para corregir la salida.');
        return;
      }

      svGpsMsg.textContent  = '📍 Ubicación confirmada (' + distancia + ' m)';
      svBtnConf.textContent = 'Registrando...';

      await apiMarcar(session.token, lat, lng, { fecha, hora: hora + ':00' });

      modalSV.style.display = 'none';
      showAlert('✅ Salida del ' + fecha + ' a las ' + hora + ' registrada correctamente.', 'success');
      await cargarEstado();
      await cargarHistorial();

    } catch (err) {
      const msg = (err && err.name === 'ApiError') ? err.message : (err.message || 'Error al registrar. Intenta de nuevo.');
      mostrarSvError(msg);
      svGpsMsg.style.display = 'none';
    } finally {
      svBtnConf.disabled    = false;
      svBtnConf.textContent = 'Confirmar salida';
    }
  });

  function mostrarSvError(msg) {
    svError.textContent    = msg;
    svError.style.display  = 'block';
  }

  // ── Init ──
  cargarEstado();
  cargarHistorial();
})();
