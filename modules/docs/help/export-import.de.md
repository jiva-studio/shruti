Deine **persönlichen Daten** liegen in einer lokalen Datenbank auf dem Gerät.
Sie werden niemals an einen Server gesendet. Um sie zwischen Geräten zu
übertragen oder eine Sicherung aufzubewahren, unterstützt die App Export und
Import.

## Was in der Sicherung enthalten ist

Eine Sicherungsdatei umfasst alles Persönliche:

- Deine Playlist und die Reihenfolge der Tracks darin.
- Den Hörfortschritt jedes Tracks und welche Tracks du abgeschlossen hast.
- Notizen und Lesezeichen.
- Datensätze zu heruntergeladenen Tracks.
- Gespeicherte Suchfilter.

Eine Sicherung enthält **nicht** den Vortragskatalog selbst — der kommt vom
Inhaltsserver. Nach dem Import auf einem neuen Gerät lädt die App den Katalog
automatisch.

## Export

1. Öffne **Einstellungen → Daten → Nutzerdaten exportieren**.
2. Auf dem Telefon öffnet sich das System-Teilen-Menü — wähle, wo gespeichert
   werden soll (Cloud-Speicher, E-Mail, Dateien usw.). Im Web startet der
   Browser einen Download.
3. Die Datei ist eine ganz normale SQLite-Datenbank.

Du kannst so oft exportieren, wie du möchtest — der Export ändert nichts in
der App.

## Import

1. Öffne **Einstellungen → Daten → Nutzerdaten importieren**.
2. Wähle eine zuvor exportierte `.db`-Datei.
3. Bestätige den Ersetzungsdialog. Die App stoppt den Player, ersetzt jede
   Nutzertabelle durch das, was in der Datei steht, und lädt neu.

> **Achtung.** Der Import **ersetzt** die vorhandenen Daten — Playlist,
> Notizen, Downloads und Fortschritt, die jetzt in der App sind, werden
> überschrieben. Das lässt sich nicht rückgängig machen. Exportiere zuerst
> den aktuellen Stand, wenn du ihn behalten möchtest.

## Cache leeren vs. Nutzerdaten löschen

In der **Gefahrenzone** (nur sichtbar, nachdem der Debug-Bereich
freigeschaltet wurde) findest du zwei unwiderrufliche Optionen, die leicht zu
verwechseln sind:

- **Cache leeren** entfernt alle heruntergeladenen Audios und Transkripte. Es
  lässt deine Playlist, Notizen oder deinen Hörfortschritt unangetastet.
- **Nutzerdaten löschen** löscht jede persönliche Tabelle — derselbe Effekt
  wie eine Neuinstallation. Der Vortragskatalog bleibt erhalten.

Exportiere immer, bevor du die Nutzerdaten löschst.
