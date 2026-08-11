export default {
  downloadFailed: "Falha no download. Verifique sua conexão com a internet e tente de novo.",
  filtersNotSaved: "Não foi possível salvar o filtro. Ele será redefinido na próxima abertura.",
  downloadsCacheUnavailable:
    "Não foi possível ler o índice de downloads. Os arquivos em cache continuam no disco.",
  trackNotFound: "Faixa não encontrada.",
  languageListUnavailable: "Não foi possível carregar os idiomas — exibindo uma lista reduzida.",
  dictionariesUnavailable:
    "Não foi possível carregar os nomes — alguns rótulos podem estar ausentes.",
  playbackFailed:
    "Não foi possível reproduzir esta palestra. Verifique sua conexão e tente novamente.",
  noAudioForLecture: "Esta palestra não tem áudio.",
  translationFailed: "Não foi possível traduzir a palestra para {language}. Tente mais tarde.",
  translationStillRunning:
    "A tradução para {language} está demorando mais que o normal — ela aparecerá assim que estiver pronta.",
  downloadStorageFull:
    "Limite de armazenamento atingido. Remova as palestras já ouvidas ou aumente o limite nas configurações.",
  downloadStorageFullAction: "Baixar mesmo assim",
  // The storage-error screen (`views/StorageError`) — shown when the local
  // databases could not be opened at all.
  storage: {
    title: "Não foi possível abrir os seus dados",
    description:
      "O banco de dados com suas notas, playlist e histórico de audição não abriu, então o aplicativo não consegue mostrar sua biblioteca.",
    advice:
      "Reinicie o aplicativo e tente de novo. Se continuar acontecendo, libere espaço no dispositivo ou reinstale o aplicativo.",
    retry: "Tentar de novo",
  },
}
