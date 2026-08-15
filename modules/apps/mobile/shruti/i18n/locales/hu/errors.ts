export default {
  downloadFailed: "A letöltés nem sikerült. Ellenőrizd az internetkapcsolatot, és próbáld újra.",
  filtersNotSaved: "Nem sikerült menteni a szűrőt. A következő indításkor visszaáll.",
  downloadsCacheUnavailable:
    "Nem sikerült beolvasni a letöltések listáját. A gyorsítótárazott fájlok továbbra is a lemezen vannak.",
  trackNotFound: "A felvétel nem található.",
  languageListUnavailable: "Nem sikerült betölteni a nyelveket — egy rövid lista jelenik meg.",
  dictionariesUnavailable: "A nevek betöltése sikertelen — egyes címkék hiányozhatnak.",
  playbackFailed:
    "Nem sikerült lejátszani ezt az előadást. Ellenőrizd a kapcsolatot, és próbáld újra.",
  noAudioForLecture: "Ehhez az előadáshoz nincs hang.",
  translationFailed: "A(z) {language} fordítás nem sikerült. Próbáld meg később.",
  translationStillRunning:
    "A(z) {language} fordítás a szokásosnál tovább tart — megjelenik, amint elkészül.",
  translationCancelled: "A(z) {language} fordítás megszakadt.",
  transcriptLanguageUnavailable: "A(z) {language} átirat nem töltődött be — a többi látható.",
  downloadStorageFull:
    "Elérted a tárhelykorlátot. Törölj meghallgatott előadásokat, vagy növeld a korlátot a beállításokban.",
  downloadStorageFullAction: "Mégis letöltöm",
  // The storage-error screen (`views/StorageError`) — shown when the local
  // databases could not be opened at all.
  storage: {
    title: "Nem sikerült megnyitni az adataidat",
    description:
      "A jegyzeteidet, a lejátszási listádat és a hallgatási előzményeidet tároló adatbázis nem nyílt meg, ezért az alkalmazás nem tudja megjeleníteni a könyvtáradat.",
    advice:
      "Indítsd újra az alkalmazást, és próbáld meg ismét. Ha továbbra is előfordul, szabadíts fel helyet az eszközön, vagy telepítsd újra az alkalmazást.",
    retry: "Újrapróbálkozás",
    reset: {
      action: "Helyi adatok visszaállítása",
      hint: "Használd, ha az újraindítás nem segít. A letöltött előadás-katalógus megmarad.",
      confirm: {
        header: "Visszaállítod a helyi adatokat?",
        message:
          "Az ezen az eszközön tárolt jegyzeteid, lejátszási listád, hallgatási előzményeid és beszélgetéseid véglegesen törlődnek. A letöltött előadás-katalógus megmarad.",
        cancel: "Mégse",
        ok: "Visszaállítás",
      },
      error: "Nem sikerült visszaállítani a helyi adatokat",
    },
  },
}
