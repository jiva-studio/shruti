Os seus **dados pessoais** ficam em um banco de dados local no aparelho. Eles
nunca são enviados a um servidor. Para levá-los entre aparelhos ou manter um
backup, o app oferece exportação e importação.

## O que vai no backup

Um arquivo de backup inclui tudo o que é pessoal:

- A sua playlist e a ordem das faixas nela.
- O progresso de escuta de cada faixa e quais faixas você concluiu.
- Notas e marcadores.
- Registros de faixas baixadas.
- Filtros de busca salvos.

Um backup **não** inclui o catálogo de aulas em si — isso vem do servidor de
conteúdo. Depois de importar em um aparelho novo, o app busca o catálogo
automaticamente.

## Exportar

1. Abra **Ajustes → Dados → Exportar dados do usuário**.
2. No celular, abre-se a folha de compartilhamento do sistema — escolha onde
   salvar (nuvem, e-mail, Arquivos, etc.). Na web, o navegador inicia um download.
3. O arquivo é um banco de dados SQLite comum.

Você pode exportar quantas vezes quiser — exportar não muda nada no app.

## Importar

1. Abra **Ajustes → Dados → Importar dados do usuário**.
2. Escolha um arquivo `.db` exportado anteriormente.
3. Confirme o diálogo de substituição. O app para o player, substitui cada tabela
   do usuário pelo que está no arquivo e recarrega.

> **Atenção.** A importação **substitui** os dados existentes — a playlist, as
> notas, os downloads e o progresso que estão no app agora serão sobrescritos. Não
> há como desfazer. Exporte o estado atual primeiro, se quiser preservá-lo.

## Limpar o cache vs. apagar os dados do usuário

Na **Zona de risco** (visível só depois de desbloquear a seção de depuração) você
encontra duas opções destrutivas fáceis de confundir:

- **Limpar o cache** remove todo o áudio e as transcrições baixados. Não mexe na
  sua playlist, nas notas nem no progresso de escuta.
- **Apagar os dados do usuário** zera todas as tabelas pessoais — mesmo efeito de
  uma instalação nova. O catálogo de aulas permanece.

Sempre exporte antes de apagar os dados do usuário.
