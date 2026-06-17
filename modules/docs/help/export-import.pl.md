Twoje **dane osobiste** znajdują się w lokalnej bazie danych na urządzeniu.
Nigdy nie są wysyłane na serwer. Aby przenieść je między urządzeniami lub
zachować kopię zapasową, aplikacja obsługuje eksport i import.

## Co zawiera kopia zapasowa

Plik kopii zapasowej zawiera wszystko, co osobiste:

- Twoją playlistę i kolejność utworów w niej.
- Postęp słuchania każdego utworu oraz informację o tym, które utwory
  ukończyłeś.
- Notatki i zakładki.
- Zapisy o pobranych utworach.
- Zapisane filtry wyszukiwania.

Kopia zapasowa **nie** zawiera samego katalogu wykładów — ten pochodzi z
serwera treści. Po imporcie na nowym urządzeniu aplikacja pobierze katalog
automatycznie.

## Eksport

1. Otwórz **Ustawienia → Dane → Eksportuj dane użytkownika**.
2. Na telefonie otworzy się systemowy panel udostępniania — wybierz, gdzie
   zapisać plik (dysk w chmurze, e-mail, Pliki itp.). W przeglądarce rozpocznie
   się pobieranie.
3. Plik to zwykła baza danych SQLite.

Możesz eksportować tak często, jak chcesz — eksport niczego w aplikacji nie
zmienia.

## Import

1. Otwórz **Ustawienia → Dane → Importuj dane użytkownika**.
2. Wybierz wcześniej wyeksportowany plik `.db`.
3. Potwierdź okno dialogowe zastąpienia. Aplikacja zatrzyma odtwarzacz,
   zastąpi każdą tabelę użytkownika zawartością pliku i przeładuje się.

> **Uwaga.** Import **zastępuje** istniejące dane — playlista, notatki,
> pobrania i postęp obecne teraz w aplikacji zostaną nadpisane. Nie można tego
> cofnąć. Jeśli chcesz zachować bieżący stan, najpierw wykonaj eksport.

## Czyszczenie pamięci podręcznej a czyszczenie danych użytkownika

W **Strefie zagrożenia** (widocznej dopiero po odblokowaniu sekcji
debugowania) znajdziesz dwie destrukcyjne opcje, które łatwo pomylić:

- **Wyczyść pamięć podręczną** usuwa całe pobrane audio i transkrypcje. Nie
  narusza Twojej playlisty, notatek ani postępu słuchania.
- **Wyczyść dane użytkownika** wymazuje każdą osobistą tabelę — efekt taki sam
  jak po świeżej instalacji. Katalog wykładów pozostaje.

Przed wyczyszczeniem danych użytkownika zawsze wykonaj eksport.
