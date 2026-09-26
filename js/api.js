// ============================================================
// API — Comunicación con Google Apps Script
// ============================================================

// Error tipado para distinguir red / servidor / auth / validación
class ApiError extends Error {
  constructor(msg, tipo = 'desconocido', datos = null) {
    super(msg);
    this.name = 'ApiError';
    this.tipo = tipo; // 'red' | 'servidor' | 'auth' | 'validacion' | 'desconocido'
    // Respuesta completa del backend. Un error de negocio puede traer datos
    // utiles junto al mensaje -por ejemplo las carpetas candidatas cuando falta
    // vincular una-, y sin esto se perdian: solo sobrevivia el texto.
    this.datos = datos;
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
    throw new ApiError(json.error, 'validacion', json);
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

// ── Roles (PLAN_ACCESO.md §3.3) ──
//
// SOLO UX. Quién puede qué lo decide el backend (`validarAdmin` /
// `validarOperacion`); esto es para no mostrarle a nadie una pantalla que le
// va a responder "No autorizado" en cada botón.

/** El rol de la sesión. Una sesión guardada antes de los roles trae solo
 *  `esAdmin`: se lee como Dirección u Operario, igual que el backend. */
function rolDeSesion(s) {
  if (!s) return '';
  if (s.rol) return String(s.rol).trim().toUpperCase();
  return s.esAdmin ? 'DIRECCION' : 'OPERARIO';
}
function esDireccion(s) { return rolDeSesion(s) === 'DIRECCION'; }
/** Dirección o Administrativo: producción, programación, cotizaciones,
 *  hoja de vida y administrar remisiones. */
function puedeOperar(s) { var r = rolDeSesion(s); return r === 'DIRECCION' || r === 'ADMINISTRATIVO'; }

/** A dónde entra cada rol. El administrativo no tiene nada que hacer en
 *  `app.html` (marcar turno) ni puede abrir `admin.html` (RRHH). */
function paginaInicio(s) {
  var r = rolDeSesion(s);
  if (r === 'DIRECCION') return 'admin.html';
  if (r === 'ADMINISTRATIVO') return 'programacion.html';
  return 'app.html';
}

/** Las páginas del navegador de módulos que son solo de Dirección. */
var PAGINAS_SOLO_DIRECCION = ['admin.html', 'facturacion.html'];

/** Quita del navegador de módulos los enlaces que el rol no puede abrir. Se
 *  corre sola al cargar cualquier página: así no hay que tocar los siete
 *  navegadores copiados (ver tests/nav_modulos.test.js). */
function ajustarNavPorRol(s) {
  if (!s || esDireccion(s)) return;
  document.querySelectorAll('nav a[href]').forEach(function (a) {
    var destino = String(a.getAttribute('href') || '').split(/[?#]/)[0];
    if (PAGINAS_SOLO_DIRECCION.indexOf(destino) !== -1) a.remove();
  });
}
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', function () {
    ajustarNavPorRol(getSession());
    montarCambioClave();
  });
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
/** Entra con cédula o correo y la clave (PLAN_ACCESO paso 2). Mientras dure la
 *  migración, la clave también puede ser el PIN viejo: entonces la respuesta
 *  trae `debeCambiarClave` y un token que solo sirve para `apiCambiarClave`. */
async function apiLogin(usuario, clave) {
  return apiCall('login', { usuario: String(usuario), clave: String(clave) });
}

// ── La clave (PLAN_ACCESO pasos 2 y 3) ──
async function apiCambiarClave(token, claveActual, claveNueva) {
  return apiCall('cambiar_clave', { token, claveActual, claveNueva });
}
async function apiClaveOlvide(usuario) {
  return apiCall('clave_olvide', { usuario: String(usuario) });
}
async function apiClaveRestablecer(usuario, codigo, claveNueva) {
  return apiCall('clave_restablecer', { usuario: String(usuario), codigo: String(codigo), claveNueva });
}
async function apiAdminClaveTemporal(token, cedulaOperario) {
  return apiCall('admin_clave_temporal', { token, cedulaOperario: String(cedulaOperario) });
}

/** La regla de la clave, para avisar antes de enviar. SOLO UX: la que decide es
 *  `_claveInvalida` (Code.gs), que además rechaza la cédula, el correo y las
 *  triviales. Devuelve el porqué, o '' si en principio sirve. */
function validarClaveLocal(clave, confirmacion) {
  var c = String(clave || '');
  if (c.length < 8) return 'La clave tiene que tener al menos 8 caracteres.';
  if (c.length > 64) return 'La clave puede tener máximo 64 caracteres.';
  if (!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(c)) return 'La clave tiene que tener al menos una letra.';
  if (!/[0-9]/.test(c)) return 'La clave tiene que tener al menos un número.';
  if (confirmacion !== undefined && c !== String(confirmacion)) return 'Las dos claves no coinciden.';
  return '';
}

/**
 * "Cambiar clave" en cualquier pantalla con sesión (PLAN_ACCESO §4.5). Se
 * agrega solo junto al botón de salir (`#logoutBtn`), como el navegador de
 * módulos: así no hay que tocar las ocho páginas, y la próxima que se agregue
 * lo trae sin que nadie se acuerde. Al cambiarla, el backend cierra las demás
 * sesiones y devuelve una nueva, que reemplaza a la guardada.
 */
function montarCambioClave() {
  var salir = document.getElementById('logoutBtn');
  var s = getSession();
  if (!salir || !s || !s.token || document.getElementById('btnCambiarClave')) return;
  var btn = document.createElement('button');
  btn.id = 'btnCambiarClave';
  btn.type = 'button';
  btn.className = salir.className;
  btn.title = 'Cambiar mi clave';
  btn.setAttribute('aria-label', 'Cambiar mi clave');
  btn.textContent = '🔑';
  salir.parentNode.insertBefore(btn, salir);
  btn.addEventListener('click', abrirCambioClave);
}

function abrirCambioClave() {
  var ov = document.getElementById('modalCambioClave');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'modalCambioClave';
    ov.className = 'modal-overlay';
    ov.innerHTML =
      '<div class="modal" style="max-width:420px;">' +
        '<div class="modal-header"><h2>Cambiar mi clave</h2></div>' +
        '<form id="formCambioClave" novalidate style="display:flex;flex-direction:column;gap:12px;">' +
          '<div class="form-group"><label for="ccActual">Clave actual</label>' +
            '<input type="password" id="ccActual" autocomplete="current-password"></div>' +
          '<div class="form-group"><label for="ccNueva">Clave nueva</label>' +
            '<input type="password" id="ccNueva" autocomplete="new-password"></div>' +
          '<div class="form-group"><label for="ccConfirma">Repite la clave nueva</label>' +
            '<input type="password" id="ccConfirma" autocomplete="new-password"></div>' +
          '<p style="font-size:0.78rem;color:var(--cf-gray-text);margin:0;">Mínimo 8 caracteres, con letras y números. ' +
            'Al cambiarla se cierran tus sesiones en otros equipos.</p>' +
          '<div id="ccError" class="alert alert-error hidden"></div>' +
          '<div class="modal-actions">' +
            '<button type="button" id="ccCancelar" class="btn btn-ghost btn-sm">Cancelar</button>' +
            '<button type="submit" id="ccGuardar" class="btn btn-primary btn-sm">Guardar</button>' +
          '</div>' +
        '</form>' +
      '</div>';
    document.body.appendChild(ov);
    var cerrar = function () { ov.classList.add('hidden'); };
    document.getElementById('ccCancelar').addEventListener('click', cerrar);
    ov.addEventListener('click', function (e) { if (e.target === ov) cerrar(); });
    document.getElementById('formCambioClave').addEventListener('submit', async function (e) {
      e.preventDefault();
      var err = document.getElementById('ccError');
      var actual = document.getElementById('ccActual').value;
      var nueva = document.getElementById('ccNueva').value;
      var mal = actual ? validarClaveLocal(nueva, document.getElementById('ccConfirma').value) : 'Escribe tu clave actual.';
      if (mal) { err.textContent = mal; err.classList.remove('hidden'); return; }
      var boton = document.getElementById('ccGuardar');
      boton.disabled = true;
      try {
        var r = await apiCambiarClave(getSession().token, actual, nueva);
        setSession(r);
        cerrar();
        alert('Listo: tu clave quedó cambiada.');
      } catch (ex) {
        if (ex && ex.tipo === 'auth') { clearSession(); location.replace('index.html'); return; }
        err.textContent = (ex && ex.message) || 'No se pudo cambiar la clave.';
        err.classList.remove('hidden');
      } finally {
        boton.disabled = false;
      }
    });
  }
  ['ccActual', 'ccNueva', 'ccConfirma'].forEach(function (id) { document.getElementById(id).value = ''; });
  document.getElementById('ccError').classList.add('hidden');
  ov.classList.remove('hidden');
  document.getElementById('ccActual').focus();
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
// `carpetaId` opcional: además del escaneo normal, fuerza ESA carpeta borrándole
// su `ultimoScan`. Hace falta porque Drive no actualiza la fecha de una carpeta
// cuando se reemplaza el contenido de un archivo que ya estaba, así que una
// exportación corregida encima de la anterior es invisible para el escaneo
// incremental — y el botón de siempre parecía no hacer nada.
async function apiProdScanNow(token, carpetaId) {
  const payload = { token };
  if (carpetaId) payload.carpetaId = carpetaId;
  return apiCall('prod_scan_now', payload);
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
// Los accesorios que pide lo que se produce en [desde, hasta] (YYYY-MM-DD).
// Materiales, unidades y cobertura en una sola respuesta. PLAN_MATERIALES.md §4.
async function apiProdMaterialesVentana(token, desde, hasta) {
  return apiCall('prod_materiales_ventana', { token, desde, hasta });
}
// Simula un pedido: N casas de una cotización del maestro. Materiales, acero y
// en cuánto tiempo se producirían. No escribe nada.
async function apiProdMaterialesSimular(token, cotizacionArchivo, casas) {
  return apiCall('prod_materiales_simular', { token, cotizacionArchivo, casas });
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
// Pausa una unidad EN PRODUCCIÓN registrando cuánto se produjo. La unidad se
// queda en su puesto de la cola pero deja de consumir días, lo que libera el cupo
// para la que se acaba de priorizar (ver PLAN_PROGRAMACION §7).
async function apiProdColaPausar(token, archivo, avanceMl) {
  return apiCall('prod_cola_pausar', { token, archivo, avanceMl });
}
async function apiProdColaReanudar(token, archivo) {
  return apiCall('prod_cola_reanudar', { token, archivo });
}
async function apiProdColaReabrir(token, archivo) {
  return apiCall('prod_cola_reabrir', { token, archivo });
}
async function apiProdColaAjustesSet(token, archivo, ritmo, fechaInicioMin) {
  return apiCall('prod_cola_ajustes_set', { token, archivo, ritmo, fechaInicioMin });
}
// archivo = proyecto (no uid). envios = [{id?, tipo:'casas'|'metros', valor, fechaEntrega?}]; [] = unir.
// Parte UN envío en varias partes, conservando su puesto en la cola. Distinto de
// apiProdEnviosSet, que redefine el reparto completo (ver PLAN_PROGRAMACION §6).
async function apiProdEnvioPartir(token, archivo, envioId, partes) {
  return apiCall('prod_envio_partir', { token, archivo, envioId, partes });
}
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
// Remisiones del sistema anterior: solo el número, sin documento (ver
// remAntiguaAgregar). `datos` = { numero, fecha, cotizacionArchivo, envioId,
// pesoKg, facturaNumero, nota }.
async function apiRemAntiguaAgregar(token, datos) {
  return apiCall('remision_antigua_agregar', Object.assign({ token }, datos));
}
async function apiRemAntiguaAnular(token, antId, motivo) {
  return apiCall('remision_antigua_anular', { token, antId, motivo });
}
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
// `envioId` vacío = sugerir contra el proyecto completo, como antes de existir
// el vínculo remisión-envío (PLAN_PROGRAMACION §8).
async function apiRemSugerir(token, archivo, docIdActual, envioId) {
  return apiCall('remision_sugerir', { token, archivo, docIdActual: docIdActual || '',
                                       envioId: envioId || '' });
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
//
// huella: la que vino en `remision_detalle` al abrir el editor. Es el control de
// concurrencia de los campos que OTROS endpoints escriben —observaciones y el
// bloque del transportador— y el backend rechaza el guardado si cambiaron desde
// entonces (R4-06). Se manda vacía al crear un documento nuevo: no hay versión
// previa contra la cual comparar.
async function apiRemGuardar(token, remision, detalle, motivo, huella) {
  return apiCall('remision_guardar', {
    token, remision, detalle, motivo: motivo || '', huella: huella || '',
  });
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

// ── Facturación (PLAN_FACTURACION.md) ───────────────────────────────────────
// `factura_tablero` devuelve los tres cortes en UNA llamada: los tres salen de
// las mismas lecturas de hoja, así que partirlo en tres triplicaría el costo
// para pintar una sola pantalla.
async function apiFacturaTablero(token) {
  return apiCall('factura_tablero', { token });
}
// monto va SIN AIU y montoAiu aparte: el subtotal de la cotización incluye AIU,
// pero no todas las facturas lo cobran, y mezclarlos esconde la diferencia.
// `concepto` es CONTRATO (por defecto) o PROVEEDURIA: lo segundo es material
// que no es acero —las Q— y no se compara contra el valor aprobado, porque no
// tiene uno. Se manda aparte y no se deduce del monto.
// `sobreAviso` marca las que una persona aceptó después de que la compuerta las
// frenara. Queda en la auditoría y NO en `origen`: son dos poblaciones
// distintas y hay que poder medirlas por separado.
async function apiFacturaAsignar(token, facturaNumero, cotizacionArchivo, monto, montoAiu, kgFacturado, origen, nota, concepto, sobreAviso) {
  return apiCall('factura_asignar', {
    token, facturaNumero, cotizacionArchivo, monto, montoAiu, kgFacturado, origen, nota,
    concepto: concepto || 'CONTRATO',
    sobreAviso: !!sobreAviso,
  });
}
async function apiFacturaAsignacionAnular(token, asigId, motivo) {
  return apiCall('factura_asignacion_anular', { token, asigId, motivo });
}
// Qué factura corrige una nota crédito que el sync no pudo resolver. Queda en
// `RelacionesNotaCredito`, aparte del maestro, que es espejo de Dataico.
async function apiFacturaNcRelacionar(token, ncNumero, facturaNumero, nota) {
  return apiCall('factura_nc_relacionar', { token, ncNumero, facturaNumero, nota: nota || '' });
}
async function apiFacturaNcRelacionAnular(token, relId, motivo) {
  return apiCall('factura_nc_relacion_anular', { token, relId, motivo });
}
async function apiFacturaCotizacion(token, cotizacionArchivo) {
  return apiCall('factura_cotizacion', { token, cotizacionArchivo });
}
// Marca una remisión como facturada. Una remisión no se reparte entre dos
// facturas: si ya tiene otra, el backend la rechaza en vez de pisarla.
// Sin fecha ni CUFE: se pedían en cada registro y no los leía nadie — eran
// columnas de solo escritura. Y sobraban por partida doble, porque el maestro
// `Facturas` ya los trae de Dataico. El backend ignora los dos si llegan.
async function apiRemisionFacturar(token, docId, facturaNumero) {
  return apiCall('remision_facturar', { token, docId, facturaNumero });
}
async function apiRemisionDesfacturar(token, docId, motivo) {
  return apiCall('remision_desfacturar', { token, docId, motivo });
}
// Lee las notas de una factura y propone contra qué cotizaciones va. SOLO LEE:
// nada se asigna hasta que una persona lo confirme.
async function apiFacturaSugerencias(token, facturaNumero) {
  return apiCall('factura_sugerencias', { token, facturaNumero });
}
// Asigna de un golpe las facturas que pasan la compuerta (`_factCompuerta`).
//
// SIN `confirmar` ES UN SIMULACRO: no escribe nada y devuelve exactamente lo
// que haría. Es lo que la pantalla muestra antes de que alguien apruebe.
//
// SOLO VIAJAN NÚMEROS. Ni montos, ni proyectos, ni orígenes: el reparto lo
// decide el servidor volviendo a correr la compuerta dentro del lock. Mandarlo
// desde acá sería dejar que el navegador decida contra qué proyecto se cobra.
async function apiFacturaAsignarLote(token, numeros, confirmar) {
  return apiCall('factura_asignar_lote', { token, numeros, confirmar: !!confirmar });
}
// Cierre de cobro de una cotización: "ya terminó de cobrarse, y la diferencia
// fue por esto". El servidor recalcula los números; del cliente solo viajan el
// archivo, el motivo y la nota.
async function apiFacturaCerrar(token, cotizacionArchivo, motivo, nota) {
  return apiCall('factura_cerrar', { token, cotizacionArchivo, motivo, nota });
}
async function apiFacturaCierreAnular(token, cierreId, motivo) {
  return apiCall('factura_cierre_anular', { token, cierreId, motivo });
}
// "Cerrar las que cuadran". Sin `confirmar` es un simulacro, igual que el lote
// de asignar: el servidor vuelve a medir al escribir.
async function apiFacturaCerrarLote(token, confirmar) {
  return apiCall('factura_cerrar_lote', { token, confirmar: !!confirmar });
}
