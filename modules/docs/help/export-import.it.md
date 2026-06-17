I tuoi **dati personali** vivono in un database locale sul dispositivo. Non
vengono mai inviati a un server. Per portarli da un dispositivo all'altro o
tenere un backup, l'app supporta l'esportazione e l'importazione.

## Cosa contiene il backup

Un file di backup include tutto ciò che è personale:

- La tua playlist e l'ordine delle tracce al suo interno.
- I progressi di ascolto per ogni traccia e quali tracce hai completato.
- Note e segnalibri.
- I record delle tracce scaricate.
- I filtri di ricerca salvati.

Un backup **non** include il catalogo delle lezioni in sé — quello arriva dal
server dei contenuti. Dopo l'importazione su un nuovo dispositivo, l'app
recupera automaticamente il catalogo.

## Esportazione

1. Apri **Impostazioni → Dati → Esporta i dati utente**.
2. Su un telefono si apre il foglio di condivisione di sistema — scegli dove
   salvare (cloud, email, File, ecc.). Sul web, il browser avvia un download.
3. Il file è un normale database SQLite.

Puoi esportare quante volte vuoi — l'esportazione non cambia nulla nell'app.

## Importazione

1. Apri **Impostazioni → Dati → Importa i dati utente**.
2. Scegli un file `.db` esportato in precedenza.
3. Conferma la finestra di sostituzione. L'app ferma il player, sostituisce
   ogni tabella utente con quanto contenuto nel file e si ricarica.

> **Attenzione.** L'importazione **sostituisce** i dati esistenti — playlist,
> note, download e progressi presenti ora nell'app verranno sovrascritti. Non
> c'è modo di annullare. Esporta prima lo stato attuale se vuoi conservarlo.

## Svuota la cache vs. cancella i dati utente

Nella **Zona pericolosa** (visibile solo dopo aver sbloccato la sezione di
debug) trovi due opzioni distruttive facili da confondere:

- **Svuota la cache** rimuove tutto l'audio e le trascrizioni scaricati. Non
  tocca la tua playlist, le note o i progressi di ascolto.
- **Cancella i dati utente** azzera ogni tabella personale — stesso effetto di
  un'installazione nuova. Il catalogo delle lezioni rimane.

Esporta sempre prima di cancellare i dati utente.
