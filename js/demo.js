// ============================================================
// DEMO MODE — Simula el backend sin Google Apps Script
// Incluido solo en index.html durante pruebas locales
// ============================================================

(function () {
  // Estado en memoria
  const DB = {
    operarios: [
      { cedula: '1001', nombre: 'Carlos Rodríguez', pin: '1234', cargo: 'Operario soldador', activo: true, esAdmin: false, horario: 'Doble turno - Tarde', fila: 2 },
      { cedula: '1002', nombre: 'María Gómez',      pin: '5678', cargo: 'Operario armador',  activo: true, esAdmin: false, horario: 'Doble turno - Mañana', fila: 3 },
      { cedula: '9999', nombre: 'Admin COLFRAME',   pin: '0000', cargo: 'Administrador',     activo: true, esAdmin: true,  horario: 'Jornada única', fila: 4 },
    ],
    registros: [
      { cedula:'1001', nombre:'Carlos Rodríguez', tipo:'ENTRADA', fecha:'2026-05-13', hora:'14:05:22' },
      { cedula:'1001', nombre:'Carlos Rodríguez', tipo:'SALIDA',  fecha:'2026-05-13', hora:'21:38:10' },
      { cedula:'1002', nombre:'María Gómez',      tipo:'ENTRADA', fecha:'2026-05-14', hora:'06:31:05' },
      { cedula:'1002', nombre:'María Gómez',      tipo:'SALIDA',  fecha:'2026-05-14', hora:'14:02:47' },
    ],
    sesiones: {},
    estadoActual: {},
  };

  // Recuperar la sesión activa del localStorage al recargar la página
  // (sin esto, el token se pierde al navegar de index.html → app.html)
  const savedSession = (function() {
    try { return JSON.parse(localStorage.getItem('cf_session')); } catch { return null; }
  })();
  if (savedSession && savedSession.token && savedSession.cedula) {
    DB.sesiones[savedSession.token] = savedSession.cedula;
  }

  const HORARIOS = [
    { nombre:'Doble turno - Mañana', inicio:'06:30', fin:'14:00' },
    { nombre:'Doble turno - Tarde',  inicio:'14:00', fin:'21:30' },
    { nombre:'Jornada única',        inicio:'08:00', fin:'17:00' },
  ];

  function generarToken() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function buscarOperario(cedula) {
    return DB.operarios.find(o => o.cedula === String(cedula));
  }

  // Sobrescribir apiCall para interceptar todas las llamadas
  window.apiCall = async function (action, data = {}) {
    // Simular latencia de red (300-700ms)
    await new Promise(r => setTimeout(r, 300 + Math.random() * 400));

    switch (action) {

      case 'login': {
        const op = buscarOperario(data.cedula);
        if (!op) return { error: 'Cédula no encontrada' };
        if (!op.activo) return { error: 'Usuario inactivo' };
        if (op.pin !== String(data.pin)) return { error: 'PIN incorrecto' };
        const token = generarToken();
        DB.sesiones[token] = op.cedula;
        return { ok: true, token, cedula: op.cedula, nombre: op.nombre, cargo: op.cargo, horario: op.horario, esAdmin: op.esAdmin };
      }

      case 'estado': {
        const cedula = DB.sesiones[data.token];
        if (!cedula) return { error: 'Sesión inválida' };
        const regs = DB.registros.filter(r => r.cedula === cedula);
        const ultimo = regs.length ? regs[regs.length - 1] : null;
        return { ok: true, tieneEntradaAbierta: ultimo && ultimo.tipo === 'ENTRADA', ultimoRegistro: ultimo };
      }

      case 'marcar': {
        const cedula = DB.sesiones[data.token];
        if (!cedula) return { error: 'Sesión inválida' };

        // En demo, siempre aceptar ubicación (simular que está en la planta)
        const op   = buscarOperario(cedula);
        const regs = DB.registros.filter(r => r.cedula === cedula);
        const ultimo = regs.length ? regs[regs.length - 1] : null;
        const tipo = (!ultimo || ultimo.tipo === 'SALIDA') ? 'ENTRADA' : 'SALIDA';

        const ahora = new Date();
        const fecha = ahora.toISOString().slice(0, 10);
        const hora  = ahora.toTimeString().slice(0, 8);

        DB.registros.push({ cedula, nombre: op.nombre, tipo, fecha, hora });
        return { ok: true, tipo, fecha, hora, distancia: 42 };
      }

      case 'historial': {
        const cedula = DB.sesiones[data.token];
        if (!cedula) return { error: 'Sesión inválida' };
        const regs = DB.registros.filter(r => r.cedula === cedula).slice(-20).reverse();
        return { ok: true, registros: regs };
      }

      case 'admin_reporte': {
        return { ok: true, registros: DB.registros };
      }

      case 'admin_horas_extra': {
        return { ok: true, registros: [
          { cedula:'1001', nombre:'Carlos Rodríguez', fecha:'2026-05-13', horaEnt:'14:05', horaSal:'21:38', horario:'Doble turno - Tarde', horas:'0.13', tipo:'Hora Extra Nocturna', porcentaje:'75%' },
          { cedula:'1002', nombre:'María Gómez',      fecha:'2026-05-14', horaEnt:'06:31', horaSal:'14:02', horario:'Doble turno - Mañana', horas:'0.03', tipo:'Hora Extra Diurna',   porcentaje:'25%' },
        ]};
      }

      case 'admin_operarios_list': {
        return { ok: true, operarios: DB.operarios };
      }

      case 'admin_operario_add': {
        const op = data.operario;
        DB.operarios.push({ ...op, activo: true, fila: DB.operarios.length + 2 });
        return { ok: true };
      }

      case 'admin_operario_update': {
        const idx = DB.operarios.findIndex(o => o.fila === data.operario.fila);
        if (idx !== -1) DB.operarios[idx] = { ...DB.operarios[idx], ...data.operario };
        return { ok: true };
      }

      case 'admin_horarios_list': {
        return { ok: true, horarios: HORARIOS };
      }

      default:
        return { error: 'Acción no reconocida: ' + action };
    }
  };

  // Banner visible
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#F59E0B;color:#92400E;text-align:center;font-size:0.8rem;font-weight:700;padding:6px;z-index:9999;font-family:Montserrat,sans-serif;';
  banner.textContent = '⚠️ MODO DEMO — Datos ficticios. No conectado a Google Sheets.';
  document.body.appendChild(banner);

  console.log('%c[DEMO MODE] Activo. Usuarios de prueba:', 'color:#F59E0B;font-weight:bold');
  console.log('  Operario 1: cédula 1001, PIN 1234');
  console.log('  Operario 2: cédula 1002, PIN 5678');
  console.log('  Admin:      cédula 9999, PIN 0000');
})();
