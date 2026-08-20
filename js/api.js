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
/**
 * Cierra la sesión: revoca el token en el servidor y borra el local.
 *
 * La revocación va aquí adentro, y no en cada botón de "Salir", porque
 * `clearSession()` se llama desde ocho páginas y desde los manejadores de error
 * de autenticación: ponerlo en un solo sitio hace que todas lo hereden sin
 * repetir código y sin que se olvide en la próxima página que se agregue.
 *
 * Se usa `fetch` directo con `keepalive` en vez de `apiCall`, porque casi todos
 * los llamadores hacen `location.replace()` inmediatamente después: sin
 * `keepalive` el navegador cancela la petición al navegar y el token nunca se
 * revoca. Por eso tampoco se espera la respuesta — no hay nada que hacer con
 * ella, y el backend es idempotente.
 *
 * Si la revocación falla (sin red, por ejemplo) la sesión local se borra igual:
 * el token expira solo a las 12 h. Antes esa era la ÚNICA forma de cerrarla
 * (hallazgo R2-08).
 */
function clearSession() {
  try {
    const s = JSON.parse(localStorage.getItem('cf_session'));
    if (s && s.token) {
      fetch(CONFIG.APPS_SCRIPT_URL, {
        method: 'POST',
        redirect: 'follow',
        keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'logout', token: s.token }),
      }).catch(() => {});
    }
  } catch (e) { /* sesión ilegible: no hay token que revocar */ }
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
// Justificar la llegada tarde de HOY (opcional, tras marcar entrada)
async function apiJustificarTardanza(token, categoria, nota, minutos) {
  return apiCall('marcar_justificar_tardanza', { token, categoria, nota, minutos });
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
async function apiAdminDashboardTardanzas(token, desde, hasta) {
  return apiCall('admin_dashboard_tardanzas', { token, desde, hasta });
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
// nota = del proyecto (compartida por sus envíos); notaEnvio = solo de ese envío.
// Enviar undefined en cualquiera para no tocarla.
async function apiProdColaNota(token, archivo, nota, notaEnvio) {
  const payload = { token, archivo };
  if (nota !== undefined)      payload.nota = nota;
  if (notaEnvio !== undefined) payload.notaEnvio = notaEnvio;
  return apiCall('prod_cola_nota', payload);
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

// ── Hoja de vida del proyecto (agrupado por consecutivo CB) ──────────────────
async function apiProyectoHojaVida(token, cb) {
  return apiCall('proyecto_hoja_vida', { token, cb });
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

// ── Remisiones (Fase 1) ──────────────────────────────────────────────────────
// Maestros (productos + clientes con sus NIT). El backend los cachea 6 h;
// refrescar=true fuerza la relectura tras editar el catálogo.
async function apiRemMaestros(token, refrescar) {
  return apiCall('remision_maestros', { token, refrescar: !!refrescar });
}
// Selector de cotizaciones aprobadas. Este endpoint NO devuelve subtotal,
// total ni utilidad: el sistema de permisos es binario y los operarios
// también lo usan.
async function apiRemProyectos(token, buscar) {
  return apiCall('remision_proyectos_buscar', { token, buscar: buscar || '' });
}
// Detalle sugerido desde la cotización (§6.1.2 del plan): traduce la hoja
// REMISIONES de la plantilla (o, si no existe, las columnas de accesorios) a
// líneas ya multiplicadas por número de casas y con lo ya despachado restado.
async function apiRemSugerir(token, archivo, docIdActual) {
  return apiCall('remision_sugerir', { token, archivo, docIdActual: docIdActual || '' });
}
async function apiRemList(token, filtros = {}) {
  return apiCall('remision_list', { token, ...filtros });
}
async function apiRemDetalle(token, docId) {
  return apiCall('remision_detalle', { token, docId });
}
// remision = cabecera; detalle = [{idProducto, descripcion, unidad, cantidad, pesoKg, ...}]
// Sin docId crea un borrador nuevo; con docId edita el existente.
// motivo: obligatorio SOLO si la remisión ya está despachada o entregada y el
// cambio mueve cantidades o pesos — el backend corrige el libro de inventario
// con ese delta y deja el motivo en el documento (ver remGuardar, R4-02).
async function apiRemGuardar(token, remision, detalle, motivo) {
  return apiCall('remision_guardar', { token, remision, detalle, motivo: motivo || '' });
}
async function apiRemEnviar(token, docId) {
  return apiCall('remision_enviar', { token, docId });
}
async function apiRemCajasSet(token, docId, cajas) {
  return apiCall('remision_cajas_set', { token, docId, cajas });
}
// Guarda SOLO el transportador, con permiso propio (más suelto que el resto
// del documento): funciona aunque la remisión ya no sea editable en general
// para quien la llama — el conductor/vehículo a veces se define más tarde.
async function apiRemTransportadorSet(token, docId, transportador) {
  return apiCall('remision_transportador_set', { token, docId, ...transportador });
}
// Guarda SOLO la columna Caja de cada ítem, mismo permiso suelto que el
// transportador: el personal administrativo no sabe en qué caja física va a
// terminar cada cosa — eso lo decide quien empaca. cajas: [{item, cajaNum}]
async function apiRemDetalleCajasSet(token, docId, cajas) {
  return apiCall('remision_detalle_cajas_set', { token, docId, cajas });
}
// Ajusta cantidad/peso de ítems ya existentes (nunca producto, descripción ni
// unidad), mismo permiso suelto — pero motivo es obligatorio: a diferencia de
// transportador/cajas, esto sí cambia lo que se factura y lo que ve el
// cliente. items: [{item, cantidad, pesoKg}]
async function apiRemItemsAjustar(token, docId, items, motivo) {
  return apiCall('remision_items_ajustar', { token, docId, items, motivo });
}
// Reparte una línea entre varias cajas (ej. 18.750 remaches en 4 cajas de
// máximo 5.000 por peso). No pide motivo: la cantidad total no cambia, solo
// cómo se reparte físicamente. partes: [{cajaNum, cantidad, pesoKg?}]
async function apiRemItemDividir(token, docId, item, partes) {
  return apiCall('remision_item_dividir', { token, docId, item, partes });
}
// Agrega una entidad de facturación (NIT/razón social) a un cliente que ya
// existe en el catálogo, sin salir del formulario de la remisión. Útil cuando
// un mismo cod_cliente agrupa varias entidades (ej. un fondo con muchos
// constructores) que aún no están precargadas.
async function apiRemClienteNitAgregar(token, codCliente, entidad) {
  return apiCall('remision_cliente_nit_agregar', { token, codCliente, ...entidad });
}
// Admin: asigna el consecutivo RM- y escribe los movimientos de inventario.
async function apiRemConciliar(token, docId) {
  return apiCall('remision_conciliar', { token, docId });
}
async function apiRemRechazar(token, docId, motivo) {
  return apiCall('remision_rechazar', { token, docId, motivo });
}
async function apiRemAnular(token, docId, motivo) {
  return apiCall('remision_anular', { token, docId, motivo });
}
// tipo: 'remision' | 'manifiesto' | 'etiqueta' | 'etiquetas' | 'manifiestos'.
//   caja  → solo para 'manifiesto' y 'etiqueta' (una caja puntual).
//   Los plurales cubren TODAS las cajas de la remisión en un solo PDF.
// paquetes: solo para 'etiqueta' — en cuántos bultos físicos se reparte esa
//   caja (si su contenido no cupo en uno solo); imprime una etiqueta por bulto.
// porHoja: 1, 2 o 3 etiquetas por hoja. Solo aplica a etiquetas — el manifiesto
//   va dentro de la caja que describe, así que siempre lleva hoja propia.
async function apiRemPdf(token, docId, tipo, caja, paquetes, porHoja) {
  return apiCall('remision_pdf', {
    token, docId, tipo: tipo || 'remision', caja,
    paquetes: paquetes || 1, porHoja: porHoja || 1,
  });
}
