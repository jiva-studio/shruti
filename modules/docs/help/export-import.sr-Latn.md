Vaši **lični podaci** žive u lokalnoj bazi na uređaju. Nikada se ne šalju na
server. Da biste ih preneli između uređaja ili napravili rezervnu kopiju,
aplikacija podržava izvoz i uvoz.

## Šta je u rezervnoj kopiji

Datoteka rezervne kopije sadrži sve što je lično:

- Vašu listu numera i redosled numera u njoj.
- Napredak slušanja za svaku numeru i to koje ste numere završili.
- Beleške i obeleživače.
- Zapise o preuzetim numerama.
- Sačuvane filtere pretrage.

Rezervna kopija **ne** sadrži sam katalog predavanja — on dolazi sa servera
sadržaja. Posle uvoza na novom uređaju aplikacija će katalog preuzeti
automatski.

## Izvoz

1. Otvorite **Podešavanja → Podaci → Izvezi korisničke podatke**.
2. Na telefonu se otvara sistemski list za deljenje — izaberite gde da
   sačuvate (oblak, e-pošta, Datoteke i sl.). Na vebu pregledač pokreće
   preuzimanje.
3. Datoteka je obična SQLite baza.

Izvoziti možete koliko god želite — izvoz ništa ne menja u aplikaciji.

## Uvoz

1. Otvorite **Podešavanja → Podaci → Uvezi korisničke podatke**.
2. Izaberite prethodno izvezenu `.db` datoteku.
3. Potvrdite dijalog o zameni. Aplikacija zaustavlja plejer, zamenjuje svaku
   korisničku tabelu onim što je u datoteci i ponovo se učitava.

> **Pažnja.** Uvoz **zamenjuje** postojeće podatke — lista numera, beleške,
> preuzimanja i napredak koji su trenutno u aplikaciji biće prepisani.
> Poništavanje nije moguće. Ako želite da sačuvate trenutno stanje, prvo
> izvezite.

## Čišćenje keša naspram čišćenja korisničkih podataka

U **Opasnoj zoni** (vidljivoj tek nakon otključavanja sekcije za otklanjanje
grešaka) naći ćete dve razorne opcije koje je lako pomešati:

- **Očisti keš** uklanja sav preuzeti audio i transkripte. Ne dira vašu listu
  numera, beleške ni napredak slušanja.
- **Očisti korisničke podatke** briše svaku ličnu tabelu — isti efekat kao
  sveža instalacija. Katalog predavanja ostaje.

Pre čišćenja korisničkih podataka uvek napravite izvoz.
