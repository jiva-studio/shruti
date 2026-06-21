export default {
  groups: {
    subscription: "Assinatura",
    account: "Conta",
    appearance: "Aparência",
    library: "Biblioteca",
    chat: "Pergunte ao Sadhu",
    contacts: "Fale conosco",
    status: "Status",
    sadhana: "Sādhana",
    data: "Dados",
    help: "Ajuda",
    debug: "Depuração",
    danger: "Zona de risco",
    about: "Sobre",
  },
  libraryLanguages: {
    title: "Idiomas das aulas",
    description: "Mostrar aulas nestes idiomas na busca, nos temas e nas recomendações.",
  },

  account: {
    signInCta: {
      title: "Entrar",
      description: "Mantenha o seu progresso",
    },
    signInWithGoogle: "Continuar com o Google",
    signInWithApple: "Continuar com a Apple",
    signedIn: "Você está conectado",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "Seu progresso está seguro",
    signOut: "Sair",
    deleteAccount: {
      title: "Excluir conta",
      confirmWipe: "Excluir conta e apagar dados",
      confirmKeep: "Excluir conta, manter meus dados",
      errorToast: "Não foi possível excluir a conta. Tente novamente.",
      alreadyDeletedToast: "Sua conta já foi excluída.",
      rateLimitedToast: "Aguarde um pouco antes de tentar de novo.",
      networkErrorToast: "Sem conexão. Verifique sua internet e tente de novo.",
      serverErrorToast: "Algo deu errado do nosso lado. Tente novamente em instantes.",
    },
  },

  subscription: {
    title: "Assinatura",
    description: "Gerenciamento da assinatura",
    subscriptionIsActive: "Assinatura ativa",
    tapToManage: "Toque para ver ou gerenciar",
    choose: 'Apoie o "Shruti"',
    subscribe: "Assinar",
    trialBadge: "{days} dias grátis",
    trialThenPrice: "depois {price} / {period}",
    startFreeTrial: "Iniciar teste gratuito",
    trialDisclaimer:
      "Cancele quando quiser. Após o teste, a assinatura é renovada automaticamente.",
    disclaimer: "Cancele quando quiser. A assinatura é renovada automaticamente.",
    subscribed: "Assinatura concluída",
    unavailable: "As compras no aplicativo não estão disponíveis neste dispositivo.",
    manage: "Gerenciar assinatura",
    restore: "Restaurar",
    restored: "Sua assinatura foi restaurada com sucesso!",
    error: "Ocorreu um erro durante a operação. Tente novamente.",
    noSubscriptionFound:
      "Nenhuma assinatura ativa encontrada. Assine para acessar os recursos premium.",
    cantPay: "Não consigo pagar",
    cantPayEmailSubject: "Não consigo pagar",
    cantPayEmailIntro: "Não consigo pagar.",
    thanks:
      "Obrigado pela sua assinatura e apoio 🙏 Que o seu coração se encha de felicidade e que cada dia o aproxime mais da Verdade. Ficamos felizes por você estar conosco neste caminho.",
    benefits: {
      intro:
        "Estamos desenvolvendo novos recursos e melhorias. O seu apoio nos ajuda a continuar o desenvolvimento e a tornar o produto melhor.",
      benefit0: {
        title: "Novas aulas",
        description: "Sua assinatura nos ajuda a continuar adicionando novas aulas.",
      },
      benefit1: {
        title: "Marcadores",
        description:
          "Salve momentos importantes do texto e do áudio das aulas para revisitar mais tarde ou compartilhar com amigos.",
      },
      benefit2: {
        title: "Biblioteca Inteligente",
        description:
          "O app mantém aulas novas no seu aparelho e remove automaticamente as concluídas.",
      },
      benefit3: {
        title: "Seminários e cursos",
        description:
          "Adicione seminários e cursos à sua playlist para ouvi-los em uma ordem conveniente.",
      },
      benefit4: {
        title: "Coleções dinâmicas",
        description:
          "Crie coleções de aulas que se atualizam automaticamente com base nos critérios definidos.",
      },
      sakha: {
        title: "Pergunte ao Sadhu",
        description:
          "Busca em aulas, áudios e livros, encontra shlokas, gera PDFs e ajuda você a compreender os ensinamentos. Com a assinatura, você recebe um limite diário maior.",
      },
      autoScroll: {
        title: "Rolagem automática",
        description:
          "A transcrição acompanha a reprodução do áudio, mantendo o parágrafo atual sempre à vista.",
      },
      continuousPlayback: {
        title: "Reprodução contínua",
        description:
          "As aulas tocam uma após a outra — quando uma termina, a próxima começa automaticamente, mesmo com a tela bloqueada.",
      },
      shareTranscript: {
        title: "Compartilhar e exportar",
        description:
          "Compartilhe uma palestra em PDF ou transcrição de texto, ou compartilhe o áudio — com quem quiser.",
      },
      notesStudio: {
        title: "Estúdio de Notas",
        description: "Transforme suas notas das aulas em vídeos curtos e compartilhe com amigos.",
      },
      trackInfo: {
        title: "Layout das informações da faixa",
        description:
          "Escolha qual detalhe — referência, autor, local, data — fica na linha de destaque, logo abaixo do título de cada aula, e quais aparecem na linha de baixo.",
      },
    },
    periods: {
      P1M: "mês",
      P3M: "3 meses",
      P6M: "6 meses",
      P1Y: "ano",
    },
    plans: {
      $rc_monthly: "Mensal",
      $rc_three_month: "Trimestral",
      $rc_six_month: "Semestral",
      $rc_annual: "Anual",
    },
    legal: {
      privacy: "Política de Privacidade",
      terms: "Termos de Uso",
    },
  },

  help: {
    open: {
      title: "Abrir a ajuda",
      description: "Indicadores, ajustes e recursos explicados",
    },
    privacyPolicy: {
      title: "Política de Privacidade",
      description: "O que coletamos, suboperadores, exclusão de conta",
    },
  },

  appLanguage: {
    title: "Idioma",
    description: "Idioma da interface",
  },

  chatLanguage: {
    title: "Idioma do chat",
    description: "Idioma em que o Sadhu responde.",
  },

  chatTranslateCitations: {
    title: "Traduzir citações",
    description: "Traduzir as citações para o idioma do chat.",
  },

  smartLibrary: {
    title: "Biblioteca inteligente",
    description: "Mantenha aulas novas prontas e limpe o que já foi ouvido",
    enable: "Ativar",
    hint: "O app mantém um buffer de aulas não ouvidas e remove automaticamente as concluídas. Use o filtro para escolher o que entra na fila.",
    sections: {
      filter: "O que baixar",
      target: "Tamanho da fila",
      archive: "Arquivar após a escuta",
    },
    filter: {
      label: "Filtro",
      none: "Todas as aulas",
    },
    target: {
      off: "Desligado",
      "30m": "30 minutos",
      "1h": "1 hora",
      "2h": "2 horas",
      "3h": "3 horas",
      "5h": "5 horas",
      "8h": "8 horas",
      "10h": "10 horas",
    },
    archive: {
      immediate: "Imediatamente",
      _8h: "Após 8 horas",
      _1d: "Após 1 dia",
      _2d: "Após 2 dias",
      _3d: "Após 3 dias",
    },
    subtitleOff: "Atualiza aulas automaticamente e limpa após a escuta",
    subtitleArchivePrefix: "arquivar",
  },

  preferredServer: {
    title: "Servidor preferido",
  },

  trackInfo: {
    label: "Informações da faixa",
    description: "Configure a aparência da lista de faixas",
    title: "Informações da faixa",
    top: "Linha de cima",
    topField: "Campo",
    bottom: "Linha de baixo",
    none: "Nada",
    fields: {
      reference: "Referência",
      author: "Autor",
      location: "Local",
      date: "Data",
      duration: "Duração",
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
      title: "Progresso do player",
      description: "Mostrar o progresso ao redor do botão de tocar",
    },
    autoPlayNext: {
      title: "Reprodução automática",
      description: "Quando uma aula termina, começa a próxima da sua playlist",
    },
  },
  notes: {
    showPlayer: {
      title: "Player na página de notas",
      description: "Mostrar um player de áudio embutido ao lado de cada citação",
    },
  },
  activityTracker: {
    show: {
      title: "Rastreador de atividade",
      description: "Mostrar o mapa de calor de escuta na tela inicial",
    },
  },
  transcript: {
    highlightCurrentSentence: {
      title: "Destacar a frase",
      description: "Acompanhe a frase atual na transcrição",
    },
    autoScroll: {
      title: "Rolagem automática",
      description: "Acompanhe o parágrafo atual enquanto o áudio toca",
    },
    showAutomatically: {
      title: "Abrir a transcrição automaticamente",
      description: "Abrir a transcrição ao reproduzir uma aula",
    },
  },

  contacts: {
    email: {
      title: "Envie-nos um e-mail",
      description: "Tem dúvidas ou sugestões?",
      emailSubject: "Solicitação de suporte",
      emailIntro: "Descreva sua dúvida ou problema acima desta linha.",
    },
    // VK / Telegram rows render only in the ru locale (Russian-audience
    // communities), so their strings live solely in ru/settings.ts.
  },

  notifications: {
    enabled: {
      title: "Notificações",
      description: "Você receberá notificações.",
    },
    daily: {
      title: "Horário do lembrete",
      description: "O horário em que as notificações serão enviadas.",
    },
  },

  data: {
    export: {
      title: "Exportar dados do usuário",
      description: "Salvar playlist, notas e progresso em um arquivo",
      error: "Falha na exportação",
    },
    import: {
      title: "Importar dados do usuário",
      description: "Substituir os dados atuais por um arquivo exportado anteriormente",
      error: "Falha na importação",
      confirm: {
        header: "Substituir todos os dados atuais?",
        message:
          "Sua playlist, notas, downloads e progresso de escuta atuais serão substituídos pelo arquivo importado. Essa ação não pode ser desfeita.",
        ok: "Substituir",
        cancel: "Cancelar",
      },
    },
  },

  debug: {
    viewLogs: {
      title: "Ver logs",
      description: "Registro de eventos do app · {count} entradas",
    },
  },

  logs: {
    title: "Logs",
    close: "Fechar",
    copy: "Copiar",
    copied: "Logs copiados",
    clear: "Limpar",
    count: "{count} entradas",
    empty: "Nenhum log ainda",
  },

  danger: {
    clearCache: {
      title: "Limpar o cache",
      description: "Remove todos os áudios e transcrições baixados",
    },
  },

  appVersion: "Versão do app",
  contentDatabase: "Banco de conteúdo",
  activeServer: "CDN ativa",
}
