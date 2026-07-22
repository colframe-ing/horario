// ============================================================
// API — Comunicación con Google Apps Script
// ============================================================

// Error tipado para distinguir red / servidor / auth / validación
class ApiError extends Error {
  constructor(msg, tipo = 'desconocido') {
    super(msg);
    this.name = 'ApiError';
    this.tipo = tipo; // 'red' | 'servidor' | 'auth' | 'validacion' | 'desconocido'
  }
}

async function apiCall(action, data = {}) {
  let res;
  try {
    res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...data }),
    });
  } catch (e) {
    throw new ApiError('Sin conexión a internet. Verifica tu red.', 'red');
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new ApiError('Sesión expirada o sin permisos.', 'auth');
    }
    throw new ApiError('Error del servidor (' + res.status + '). Intenta de nuevo.', 'servidor');
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new ApiError('Respuesta inválida del servidor.', 'servidor');
  }
  // Errores de negocio: el backend devuelve { error: '...' }
  if (json && json.error) {
    if (/sesi[oó]n|token/i.test(json.error)) {
      throw new ApiError(json.error, 'auth');
    }
    throw new ApiError(json.error, 'validacion');
  }
  return json;
}

// ── Sesión local ──
function getSession() {
  try { return JSON.parse(localStorage.getItem('cf_session')) || null; }
  catch { return null; }
}
function setSession(data) {
  localStorage.setItem('cf_session', JSON.stringify(data));
}
function clearSession() {
  localStorage.removeItem('cf_session');
}

// ── Auth ──
async function apiLogin(cedula, pin) {
  return apiCall('login', { cedula: String(cedula), pin: String(pin) });
}

// ── Operario ──
async function apiEstado(token) {
  return apiCall('estado', { token });
}
// override: { fecha: 'YYYY-MM-DD', hora: 'HH:mm:ss' } — para corregir salidas olvidadas
async function apiMarcar(token, lat, lng, override) {
  const payload = { token, lat, lng };
  if (override) {
    if (override.fecha) payload.fechaOverride = override.fecha;
    if (override.hora)  payload.horaOverride  = override.hora;
  }
  return apiCall('marcar', payload);
}
async function apiHistorial(token) {
  return apiCall('historial', { token });
}

// ── Admin ──
async function apiAdminReporte(token, desde, hasta) {
  return apiCall('admin_reporte', { token, desde, hasta });
}
async function apiAdminHorasExtra(token, desde, hasta) {
  return apiCall('admin_horas_extra', { token, desde, hasta });
}
async function apiAdminOperariosList(token) {
  return apiCall('admin_operarios_list', { token });
}
async function apiAdminOperarioAdd(token, operario) {
  return apiCall('admin_operario_add', { token, operario });
}
async function apiAdminOperarioUpdate(token, operario) {
  return apiCall('admin_operario_update', { token, operario });
}
async function apiAdminHorariosList(token) {
  return apiCall('admin_horarios_list', { token });
}
async function apiAdminAsistencia(token, desde, hasta) {
  return apiCall('admin_asistencia', { token, desde, hasta });
}
async function apiAdminSesionUpdate(token, cedula, fecha, horaEntOriginal, horaEnt, horaSal, fechaSal) {
  return apiCall('admin_sesion_update', { token, cedula, fecha, horaEntOriginal, horaEnt, horaSal, fechaSal });
}
async function apiAdminProgramacionGet(token, desde, hasta) {
  return apiCall('admin_programacion_get', { token, desde, hasta });
}
async function apiAdminProgramacionSet(token, cedula, nombre, fecha, horaInicio, horaFin) {
  return apiCall('admin_programacion_set', { token, cedula, nombre, fecha, horaInicio, horaFin });
}
async function apiAdminPoblarSemana(token, desde, hasta, includeDomingo) {
  return apiCall('admin_poblar_semana', { token, desde, hasta, includeDomingo: !!includeDomingo });
}
async function apiAdminLimpiarSemana(token, desde, hasta) {
  return apiCall('admin_limpiar_semana', { token, desde, hasta });
}
async function apiAdminNovedadSet(token, cedula, nombre, fecha, tipo, descripcion, horas) {
  return apiCall('admin_novedad_set', { token, cedula, nombre, fecha, tipo, descripcion, horas });
}
async function apiAdminAuditoriaGet(token, desde, hasta) {
  return apiCall('admin_auditoria_get', { token, desde, hasta });
}
async function apiAdminReportePdf(token, cedula, mes) {
  return apiCall('admin_reporte_pdf', { token, cedula, mes });
}
async function apiAdminMarcarPorOperario(token, cedulaOperario, fechaOverride, horaOverride) {
  return apiCall('admin_marcar_por_operario', { token, cedulaOperario, fechaOverride, horaOverride });
}
async function apiAdminDesbloquear(token, cedulaOperario) {
  return apiCall('admin_desbloquear', { token, cedulaOperario });
}
async function apiAdminSesionesAbiertas(token) {
  return apiCall('admin_sesiones_abiertas', { token });
}
async function apiAdminEliminarRegistro(token, timestampReg) {
  return apiCall('admin_eliminar_registro', { token, timestampReg });
}

// ── Producción (Fase 1) ──────────────────────────────────────────────────────
async function apiProdProyectosList(token, filtros = {}) {
  return apiCall('prod_proyectos_list', { token, ...filtros });
}
async function apiProdProyectoDetalle(token, carpetaId) {
  return apiCall('prod_proyecto_detalle', { token, carpetaId });
}
async function apiProdScanNow(token) {
  return apiCall('prod_scan_now', { token });
}
async function apiProdProyectoEstado(token, carpetaId, estado) {
  return apiCall('prod_proyecto_estado', { token, carpetaId, estado });
}

// ── Cotizaciones (maestro externo, solo lectura) ─────────────────────────────
async function apiCotizList(token, filtros = {}) {
  return apiCall('cotiz_list', { token, ...filtros });
}
async function apiCotizMarcar(token, archivo, aprobada, cantidad) {
  const payload = { token, archivo, aprobada };
  if (cantidad !== undefined && cantidad !== null) payload.cantidad = cantidad;
  return apiCall('cotiz_marcar', payload);
}
async function apiCotizDetalle(token, archivo) {
  return apiCall('cotiz_detalle', { token, archivo });
}
async function apiCotizVincular(token, archivo, carpetaId, accion) {
  return apiCall('cotiz_vincular', { token, archivo, carpetaId, accion });
}

// ── Programación / calendario de producción (Etapa 3) ────────────────────────
async function apiProdColaGet(token) {
  return apiCall('prod_cola_get', { token });
}
async function apiProdColaReordenar(token, orden) {
  return apiCall('prod_cola_reordenar', { token, orden });
}
async function apiProdColaToggle(token, archivo, enCola) {
  return apiCall('prod_cola_toggle', { token, archivo, enCola: !!enCola });
}
async function apiProdColaFinalizar(token, archivo, fechaReal, fechaRealInicio) {
  return apiCall('prod_cola_finalizar', { token, archivo, fechaReal, fechaRealInicio });
}
async function apiProdColaIniciar(token, archivo, fechaRealInicio) {
  return apiCall('prod_cola_iniciar', { token, archivo, fechaRealInicio });
}
async function apiProdColaReabrir(token, archivo) {
  return apiCall('prod_cola_reabrir', { token, archivo });
}
async function apiProdColaAjustesSet(token, archivo, ritmo, fechaInicioMin) {
  return apiCall('prod_cola_ajustes_set', { token, archivo, ritmo, fechaInicioMin });
}
// archivo = proyecto (no uid). envios = [{id?, tipo:'casas'|'metros', valor, fechaEntrega?}]; [] = unir.
async function apiProdEnviosSet(token, archivo, envios) {
  return apiCall('prod_envios_set', { token, archivo, envios });
}
async function apiProdAlertasHigiene(token) {
  return apiCall('prod_alertas_higiene', { token });
}
async function apiProdAnomaliasList(token) {
  return apiCall('prod_anomalias_list', { token });
}
async function apiProdColaConfig(token, ritmo, fechaInicio) {
  return apiCall('prod_cola_config', { token, ritmo, fechaInicio });
}
async function apiProdColaEntrega(token, archivo, fechaEntrega) {
  return apiCall('prod_cola_entrega', { token, archivo, fechaEntrega });
}
async function apiProdCalExcepcion(token, fecha, laborable, accion, nota) {
  return apiCall('prod_cal_excepcion', { token, fecha, laborable, accion, nota });
}
