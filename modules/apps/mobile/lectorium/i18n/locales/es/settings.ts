export default {
  groups: {
    subscription: "Suscripción",
    account: "Cuenta",
    appearance: "Apariencia",
    library: "Biblioteca",
    chat: "Pregúntale a Sadhu",
    contacts: "Contáctanos",
    status: "Estado",
    sadhana: "Sādhana",
    data: "Datos",
    help: "Ayuda",
    debug: "Depuración",
    danger: "Zona de peligro",
    about: "Acerca de",
  },
  libraryLanguages: {
    title: "Idiomas de las clases",
    description: "Muestra clases en estos idiomas en búsqueda, temas y recomendaciones.",
  },

  account: {
    signInCta: {
      title: "Iniciar sesión",
      description: "Conserva tu progreso",
    },
    signInWithGoogle: "Continuar con Google",
    signInWithApple: "Continuar con Apple",
    signInWithEmail: "Continuar con correo",
    email: {
      title: "Iniciar sesión con correo",
      emailStep: "Te enviaremos un código de un solo uso por correo, sin contraseña.",
      emailLabel: "Correo electrónico",
      emailPlaceholder: "you{'@'}example.com",
      sendCode: "Enviar código",
      codeStep: "Introduce el código de 6 dígitos que enviamos a {email}.",
      codeLabel: "Código",
      codePlaceholder: "Código de 6 dígitos",
      verify: "Iniciar sesión",
      resend: "Reenviar código",
      resendIn: "Reenviar en {seconds} s",
      changeEmail: "Cambiar correo",
      errors: {
        invalidEmail: "Introduce una dirección de correo válida.",
        invalidCode: "Ese código no es válido o ha caducado.",
        throttled: "Espera un momento antes de pedir otro código.",
        disabled: "El inicio de sesión por correo no está disponible ahora mismo.",
        network: "Sin conexión. Comprueba tu internet e inténtalo de nuevo.",
        server: "Algo salió mal por nuestra parte. Inténtalo de nuevo en un momento.",
        generic: "Algo salió mal. Inténtalo de nuevo.",
      },
    },
    signedIn: "Has iniciado sesión",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "Tu progreso está a salvo",
    signOut: "Cerrar sesión",
    signOutWipeToast:
      "Sesión cerrada. Tus notas y conversaciones permanecen en tu cuenta y volverán al iniciar sesión. Las clases descargadas se eliminaron de este dispositivo y habrá que descargarlas de nuevo.",
    signOutWipeToastChatLocal:
      "Sesión cerrada. Tus notas permanecen en tu cuenta y volverán al iniciar sesión. La sincronización de conversaciones estaba desactivada, así que solo estaban en este dispositivo y se han eliminado. Las clases descargadas también se eliminaron y habrá que descargarlas de nuevo.",
    signOutWipeUnsentSuffix:
      "Los últimos cambios no se pudieron subir antes de cerrar sesión y se han perdido.",
    deleteAccount: {
      title: "Eliminar cuenta",
      confirmWipe: "Eliminar cuenta y borrar datos",
      confirmKeep: "Eliminar cuenta, conservar mis datos",
      errorToast: "No se pudo eliminar la cuenta. Inténtalo de nuevo.",
      alreadyDeletedToast: "Tu cuenta ya está eliminada.",
      rateLimitedToast: "Espera un momento antes de volver a intentarlo.",
      networkErrorToast: "Sin conexión. Comprueba tu internet e inténtalo de nuevo.",
      serverErrorToast: "Algo salió mal por nuestra parte. Inténtalo de nuevo en un momento.",
    },
  },

  subscription: {
    title: "Suscripción",
    description: "Gestión de la suscripción",
    subscriptionIsActive: "La suscripción está activa",
    tapToManage: "Toca para ver o gestionar",
    choose: 'Apoya "Shruti"',
    subscribe: "Suscribirse",
    trialBadge: "{days} días gratis",
    trialThenPrice: "luego {price} / {period}",
    startFreeTrial: "Empezar prueba gratis",
    trialDisclaimer:
      "Cancela cuando quieras. Tras la prueba, la suscripción se renueva automáticamente.",
    disclaimer: "Cancela cuando quieras. La suscripción se renueva automáticamente.",
    subscribed: "Suscripción completada",
    loading: "Cargando opciones de suscripción…",
    unavailable: "Las compras dentro de la aplicación no están disponibles en este dispositivo.",
    unconfirmed: "No pudimos confirmar tu suscripción. Si ya tienes una, toca «Restaurar».",
    manage: "Gestionar suscripción",
    restore: "Restaurar",
    restored: "¡Tu suscripción se ha restaurado correctamente!",
    error: "Ocurrió un error durante la operación. Inténtalo de nuevo.",
    noSubscriptionFound:
      "No se encontró ninguna suscripción activa. Suscríbete para acceder a las funciones premium.",
    thanks:
      "Gracias por tu suscripción y tu apoyo 🙏 Que tu corazón se llene de felicidad y que cada día te acerque más a la Verdad. Nos alegra que estés con nosotros en este camino.",
    benefits: {
      progress: {
        title: "Sigue tu progreso",
        description: "Sigue tu racha de escucha y retoma justo donde lo dejaste.",
      },
      andMore: {
        title: "Y mucho más",
        description: "Reproducción continua, compartir, el estudio de notas y mucho más.",
      },
      intro:
        "Estamos implementando nuevas funciones y mejoras. Tu apoyo nos ayuda a seguir desarrollando y a mejorar el producto.",
      benefit0: {
        title: "Nuevas clases",
        description: "Tu suscripción nos ayuda a añadir nuevas clases.",
      },
      benefit1: {
        title: "Marcadores",
        description: "Guarda momentos clave de una clase para volver a ellos o compartir.",
      },
      benefit2: {
        title: "Biblioteca inteligente",
        description: "Mantiene clases nuevas en tu dispositivo y elimina las terminadas.",
      },
      benefit3: {
        title: "Seminarios y cursos",
        description: "Añade seminarios y cursos a tu lista para escucharlos en un orden cómodo.",
      },
      benefit4: {
        title: "Colecciones dinámicas",
        description:
          "Crea colecciones de clases que se actualizarán automáticamente según los criterios que elijas.",
      },
      sakha: {
        title: "Pregúntale a Sadhu",
        description: "Busca en clases, audios y libros y explica las enseñanzas.",
      },
      autoScroll: {
        title: "Desplazamiento automático",
        description: "La transcripción sigue el audio y el párrafo actual queda a la vista.",
      },
      continuousPlayback: {
        title: "Reproducción continua",
        description:
          "Las clases suenan una tras otra — cuando una termina, la siguiente comienza automáticamente, incluso con la pantalla bloqueada.",
      },
      shareTranscript: {
        title: "Compartir y exportar",
        description:
          "Comparte una conferencia como PDF o transcripción de texto, o comparte su audio — con quien quieras.",
      },
      notesStudio: {
        title: "Estudio de notas",
        description:
          "Convierte tus notas de las clases en vídeos cortos y compártelos con tus amigos.",
      },
      trackInfo: {
        title: "Diseño de la información de pista",
        description:
          "Elige qué detalle —referencia, autor, lugar, fecha— ocupa la destacada línea superior bajo el título de cada clase, y cuáles se muestran en la línea de abajo.",
      },
    },
    periods: {
      P1M: "mes",
      P3M: "3 meses",
      P6M: "6 meses",
      P1Y: "año",
    },
    plans: {
      $rc_monthly: "Mensual",
      $rc_three_month: "Trimestral",
      $rc_six_month: "Semestral",
      $rc_annual: "Anual",
    },
    legal: {
      privacy: "Política de privacidad",
      terms: "Términos de uso",
    },
  },

  help: {
    open: {
      title: "Abrir ayuda",
      description: "Indicadores, ajustes y funciones explicados",
    },
    privacyPolicy: {
      title: "Política de privacidad",
      description: "Qué recopilamos, subprocesadores, eliminación de cuenta",
    },
  },

  appLanguage: {
    title: "Idioma",
    description: "Idioma de la interfaz",
    loadFailedToast: "No se pudo cargar ese idioma. Inténtalo de nuevo.",
  },

  chatLanguage: {
    title: "Idioma del chat",
    description: "Idioma en el que responde Sadhu.",
  },

  chatTranslateCitations: {
    title: "Traducir citas",
    description: "Traducir las citas al idioma del chat.",
  },

  syncChats: {
    title: "Sincronizar chats",
    description: "Mantén tus conversaciones de Ask Sadhu sincronizadas en todos tus dispositivos.",
  },

  downloadLimit: {
    title: "Límite de descargas",
    unlimited: "Sin límite",
    usage: "{used} de {limit}",
    usageUnlimited: "{used} descargados",
  },

  smartLibrary: {
    title: "Biblioteca inteligente",
    description: "Mantén clases nuevas listas y limpia después de escuchar",
    enable: "Activar",
    hint: "La app mantiene una reserva de clases sin escuchar y elimina automáticamente las terminadas. Usa el filtro para elegir qué se pone en cola.",
    sections: {
      filter: "Qué descargar",
      target: "Duración de la cola",
      archive: "Archivar tras escuchar",
    },
    filter: {
      label: "Filtro",
      none: "Todas las clases",
    },
    target: {
      off: "Desactivado",
      "30m": "30 minutos",
      "1h": "1 hora",
      "2h": "2 horas",
      "3h": "3 horas",
      "5h": "5 horas",
      "8h": "8 horas",
      "10h": "10 horas",
    },
    archive: {
      off: "Nunca",
      immediate: "De inmediato",
      _8h: "Tras 8 horas",
      _1d: "Tras 1 día",
      _2d: "Tras 2 días",
      _3d: "Tras 3 días",
    },
    subtitleOff: "Actualiza las clases automáticamente y limpia después de escuchar",
    subtitleArchivePrefix: "archivo",
  },

  preferredServer: {
    title: "Servidor preferido",
  },

  trackInfo: {
    label: "Información de pista",
    description: "Configura cómo se ve la lista de pistas",
    title: "Información de pista",
    top: "Línea superior",
    topField: "Campo",
    bottom: "Línea inferior",
    none: "Nada",
    fields: {
      reference: "Referencia",
      author: "Autor",
      location: "Lugar",
      date: "Fecha",
      duration: "Duración",
    },
    preview: {
      title: "Happiness Beyond The Senses",
      author: "A.C. Bhaktivedanta Swami",
      location: "Bombay",
      date: "21 abr 1974",
      duration: "47min",
    },
  },
  player: {
    showProgress: {
      title: "Progreso del reproductor",
      description: "Mostrar el progreso alrededor del botón de reproducción",
    },
    autoPlayNext: {
      title: "Reproducción automática",
      description: "Cuando una clase termina, iniciar la siguiente de tu lista",
    },
  },
  notes: {
    showPlayer: {
      title: "Reproductor en la página de notas",
      description: "Mostrar un reproductor de audio integrado junto a cada cita",
    },
  },
  activityTracker: {
    show: {
      title: "Registro de actividad",
      description: "Mostrar el mapa de calor de escucha en la pantalla de inicio",
    },
  },
  transcript: {
    highlightCurrentSentence: {
      title: "Resaltar frase",
      description: "Seguir la frase actual en la transcripción",
    },
    autoScroll: {
      title: "Desplazamiento automático",
      description: "Seguir el párrafo actual mientras suena el audio",
    },
    showAutomatically: {
      title: "Abrir la transcripción automáticamente",
      description: "Abrir la transcripción al reproducir una clase",
    },
  },

  contacts: {
    studio: {
      title: "Jiva Studio",
      description: "Visita nuestro estudio y descubre nuestras otras apps",
    },
    email: {
      title: "Escríbenos un correo",
      description: "¿Tienes preguntas o sugerencias?",
      emailSubject: "Solicitud de soporte",
      emailIntro: "Describe tu pregunta o problema encima de esta línea.",
    },
    // VK / Telegram rows render only in the ru locale (Russian-audience
    // communities), so their strings live solely in ru/settings.ts.
  },

  notifications: {
    enabled: {
      title: "Notificaciones",
      description: "Recibirás notificaciones.",
    },
    daily: {
      title: "Hora del recordatorio",
      description: "La hora a la que se enviarán las notificaciones.",
    },
  },

  data: {
    export: {
      title: "Exportar datos del usuario",
      description: "Guardar la lista, las notas y el progreso en un archivo",
      error: "Error al exportar",
    },
    import: {
      title: "Importar datos del usuario",
      description: "Reemplazar los datos actuales con un archivo exportado previamente",
      error: "Error al importar",
      confirm: {
        header: "¿Reemplazar todos los datos actuales?",
        message:
          "Tu lista, notas, descargas y progreso de escucha actuales se reemplazarán por el archivo importado. Esto no se puede deshacer.",
        ok: "Reemplazar",
        cancel: "Cancelar",
      },
    },
  },

  debug: {
    viewLogs: {
      title: "Ver registros",
      description: "Registro de eventos de la app · {count} entradas",
    },
    email: {
      title: "Enviar diagnóstico",
      description: "Envía registros y estado del sistema al soporte",
      emailSubject: "Informe de diagnóstico",
      emailIntro: "Describe tu pregunta o problema encima de esta línea.",
    },
  },

  logs: {
    title: "Registros",
    close: "Cerrar",
    copy: "Copiar",
    copied: "Registros copiados",
    clear: "Borrar",
    count: "{count} entradas",
    empty: "Aún no hay registros",
  },

  danger: {
    clearCache: {
      title: "Borrar caché",
      description: "Elimina todo el audio y las transcripciones descargados",
    },
  },

  appVersion: "Versión de la app",
  contentDatabase: "Base de datos de contenido",
  activeServer: "CDN activo",
}
