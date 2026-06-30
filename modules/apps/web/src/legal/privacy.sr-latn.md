# Politika privatnosti

_Datum stupanja na snagu: 18. jun 2026._

Ova politika privatnosti odnosi se na aplikaciju Shruti (u daljem tekstu „Aplikacija") za mobilne uređaje koju je kreirao Aleksei Leontev (u daljem tekstu „Pružalac usluge") kao besplatnu uslugu. Aplikacija uključuje opcionu plaćenu pretplatu i opcioni korisnički nalog. Ova usluga je namenjena za korišćenje „TAKVA KAKVA JESTE".

## Koje informacije Aplikacija prikuplja i kako se one koriste?

Aplikacija ne zahteva registraciju za korišćenje besplatnih funkcija. Lični podaci se obrađuju samo kada se izričito opredelite za određenu funkciju — kupovinu pretplate, prijavu putem Apple ili Google naloga, ili korišćenje četa u aplikaciji.

Ako odlučite da se prijavite putem Apple ili Google naloga, obrađuju se sledeći podaci:

- **Adresa e-pošte** — koju vraća provajder identiteta i koja se čuva na našem bekendu radi identifikacije vašeg naloga prilikom narednih prijava i na više uređaja.
- **Ime** — koje Apple vraća samo prilikom prve prijave (Apple prijava vam omogućava da podelite ili sakrijete svoje pravo ime; ono što tamo izaberete jeste ono što mi primamo). Čuva se jednom i ne prepisuje se prilikom narednih prijava. Google ne dostavlja ime osim ako mu vi to ne odobrite.
- **URL profilne slike** — samo Google, koristi se za prikaz vašeg avatara u aplikaciji.
- **Identitet provajdera** — neproziran korisnički id koji dostavlja Apple ili Google, koji se koristi za povezivanje budućih prijava sa istim nalogom.

Prijava je u potpunosti opciona. Aplikacija radi anonimno bez naloga.

Ako odlučite da kupite ili obnovite pretplatu, obrađuju se sledeći podaci:

- **Istorija kupovina** — koje ste proizvode pretplate kupili, obnovili ili otkazali. Koristi se za odobravanje pristupa plaćenim funkcijama i za vraćanje vaše pretplate nakon ponovne instalacije Aplikacije.
- **Anonimni identifikator korisnika** — nasumičan identifikator generisan na vašem uređaju koji čuva naš provajder pretplata. Nije povezan sa vašim imenom, e-poštom niti bilo kojim nalogom koji kontrolišete.
- **Identifikator uređaja** — koriste ga Apple i Google za proveru potvrda o kupovini i sprečavanje prevara. Sama Aplikacija ne čuva niti koristi ovaj identifikator u bilo koju drugu svrhu.

Ovi podaci se koriste isključivo za rad funkcije pretplate. Ne koriste se za oglašavanje, profilisanje niti praćenje između aplikacija.

## Da li Aplikacija prikuplja precizne informacije o lokaciji uređaja u realnom vremenu?

Ova Aplikacija ne prikuplja precizne informacije o lokaciji vašeg mobilnog uređaja.

## Čet u aplikaciji („Ask Sadhu") i AI funkcije

Aplikacija uključuje opcionu funkciju četa koja odgovara na pitanja o biblioteci predavanja koristeći veliki jezički model (LLM). Kada pošaljete poruku, obrađuje se sledeće:

- **Tekst poruke** — pitanje koje ste uneli, zajedno sa relevantnim odlomcima preuzetim iz biblioteke predavanja, šalje se LLM-u radi generisanja odgovora.
- **Identifikator sesije** — nasumičan id po razgovoru koji se koristi za održavanje koherentnosti dijaloga kroz razmene. Nije povezan sa vašim imenom ili e-poštom.
- **Opciona povratna informacija** — ako dodirnete palac gore / palac dole na odgovoru, ta ocena se čuva uz odgovarajuću razmenu.

Saobraćaj četa se usmerava kroz **OpenRouter, Inc.** (LLM gateway) ka **Google Gemini** modelima kojima upravlja Google. Nijedan drugi LLM provajder trenutno ne prima vaše poruke iz četa. Sadržaj četa se koristi isključivo za generisanje odgovora koji vidite i za poboljšanje kvaliteta funkcije; ne koristi se za oglašavanje niti profilisanje.

Da bismo pronašli odlomke iz predavanja relevantne za vaše pitanje, tekst vaše poruke se takođe prosleđuje kroz OpenRouter ka modelu `text-embedding-3-small` kompanije **OpenAI**, koji tekst pretvara u numerički vektor koji se koristi za semantičku pretragu biblioteke predavanja. Šalje se samo tekst poruke; nijedan identifikator naloga, istorija ili podaci o uređaju ne prate zahtev za embedding.

Pored toga, svaku razmenu u četu — vašu poruku, preuzete odlomke, odgovor modela i informacije o vremenu — beležimo u **Langfuse**, alat za posmatranje otvorenog koda koji pokrećemo na sopstvenoj infrastrukturi. Langfuse se koristi isključivo za otklanjanje grešaka u kvalitetu odgovora i istraživanje neuspeha. Podaci ne napuštaju naše servere i ne dele se ni sa jednom trećom stranom.

## Gde se obrađuju zahtevi iz četa

Naš bekend za čet radi na jednoj globalnoj lokaciji. Uređaji izvan Rusije povezuju se direktno na njega. Uređaji u Rusiji povezuju se preko reverznog proksija koji se hostuje na VPS-u baziranom u Rusiji i koji prosleđuje zahtev istom bekendu; odgovor se vraća istom putanjom. Proksi ne menja sadržaj poruke — samo dodaje serversku oznaku koja identifikuje da zahtev potiče iz Rusije.

Za zahteve sa tom oznakom, pravila čuvanja podataka na bekendu su:

- komentari sa slobodnim tekstom u okviru povratne informacije se ne čuvaju;
- tela poruka se ne pojavljuju u pristupnim zapisima (access logs);
- identifikator korisnika u Langfuse tragovima posmatranja je jednosmerni soljeni heš, tako da se tragovi ne mogu povezati sa određenim nalogom.

Sam sadržaj četa putuje ka OpenRouter i Gemini radi generisanja odgovora, tačno onako kako je opisano u odeljku „Čet u aplikaciji" iznad. Gornja pravila se primenjuju samo na dugoročno čuvanje podataka na našoj sopstvenoj infrastrukturi.

## Dijagnostički zapisi i evidencija četa

Da bismo održali rad usluge i poboljšali kvalitet odgovora, bekend Aplikacije čuva:

- **Servisne zapise** — metapodatke zahteva, evidenciju grešaka i merenja performansi. Oni ne uključuju vaše poruke iz četa.
- **Evidenciju četa** — vaše poruke, odlomke koje smo pronašli i odgovor modela za svaku razmenu. Koristi se za otklanjanje grešaka u kvalitetu odgovora i poboljšanje sistema.

Oboje se nalazi na infrastrukturi kojom sami upravljamo — ne dele se ni sa jednom trećom stranom za analitiku ili posmatranje. Servisni zapisi se čuvaju do 30 dana; evidencija četa do 90 dana. Kada izbrišete svoj nalog, vaša evidencija četa se odmah uklanja — pogledajte odeljak _Brisanje naloga_ ispod.

## Prijavljivanje padova i grešaka

Da bismo otkrili i ispravili padove i greške, Aplikacija šalje automatske izveštaje o padovima i greškama sa vašeg uređaja u **Sentry**, uslugu za praćenje grešaka kojom upravlja Functional Software, Inc. (poslujući kao Sentry). Izveštaj se generiše samo kada se aplikacija sruši ili naiđe na neočekivanu grešku i sadrži:

- **Detalje o grešci** — tip greške, poruku i stack trace koji prikazuje gde se u kodu greška dogodila.
- **Informacije o uređaju i aplikaciji** — model uređaja, verziju operativnog sistema, verziju/build aplikacije i jezik.
- **Kratak trag nedavnih događaja u aplikaciji** („breadcrumbs") koji su prethodili grešci — na primer koji su ekrani otvarani ili koja je pozadinska operacija zakazala.

Ovi izveštaji **ne** uključuju vaše ime, adresu e-pošte, poruke iz četa niti upite pretrage. Adrese e-pošte se uklanjaju iz izveštaja pre nego što napuste vaš uređaj, a onemogućili smo automatsko prikupljanje vaše IP adrese od strane Sentry-ja. Izveštaj može sadržati neproziran tehnički identifikator (kao što je anonimni korisnički id ili id uređaja) koji se koristi samo za grupisanje povezanih grešaka; oni nisu povezani sa vašim imenom ili e-poštom. Ovi podaci se koriste isključivo za održavanje stabilnosti Aplikacije i ne koriste se za oglašavanje, profilisanje niti praćenje. Izveštaje obrađuje Sentry u Sjedinjenim Američkim Državama. [Sentry politika privatnosti](https://sentry.io/privacy/).

## Podobrađivači (sub-processors)

Aplikacija se oslanja na mali skup trećih strana — svaka je angažovana samo za navedenu funkciju i deli se samo navedeni podatak. Nijedna druga treća strana ne prima nikakve podatke od Aplikacije.

- **RevenueCat, Inc.** (pretplate) — proverava kupovine u aplikaciji, upravlja pravima pristupa i pokreće tok vraćanja kupovina. Prima potvrdu o kupovini i anonimni nasumični identifikator kreiran na vašem uređaju (`$RCAnonymousID:...`). Ovaj identifikator _nije_ povezan sa id-om vašeg Lectorium naloga, imenom ili e-poštom. [RevenueCat politika privatnosti](https://www.revenuecat.com/privacy).
- **Apple Inc.** (na iOS-u) i **Google LLC** (na Android-u) — obrađuju samu transakciju kupovine i izdaju potvrde o proveri. **Apple** dodatno obezbeđuje tok prijave putem Apple naloga kada ga izaberete. **Google** dodatno obezbeđuje tok prijave putem Google naloga kada ga izaberete. Njihovo postupanje sa ovim podacima uređeno je njihovim odgovarajućim politikama privatnosti.
- **OpenRouter, Inc.** (čet u aplikaciji) — LLM gateway koji prosleđuje vaše upite iz četa i preuzete odlomke iz predavanja sa našeg bekenda ka osnovnom provajderu modela i vraća odgovor. Takođe usmerava zahteve za embedding ka OpenAI radi semantičke pretrage biblioteke predavanja. [OpenRouter politika privatnosti](https://openrouter.ai/privacy).
- **Google LLC** (čet u aplikaciji) — upravlja Google Gemini modelima koji trenutno generišu odgovor u četu nakon OpenRouter-a. [Google politika privatnosti](https://policies.google.com/privacy).
- **OpenAI, L.L.C.** (čet u aplikaciji) — upravlja modelom `text-embedding-3-small` koji vašu poruku iz četa pretvara u vektor pretrage koji se koristi za preuzimanje relevantnih odlomaka iz predavanja. Dostupan preko OpenRouter-a; šalje se samo tekst poruke. [OpenAI politika privatnosti](https://openai.com/policies/privacy-policy).
- **Functional Software, Inc. (poslujući kao Sentry)** (prijavljivanje padova i grešaka) — prima automatske izveštaje o padovima i greškama iz aplikacije: grešku i njen stack trace, informacije o uređaju / OS-u / verziji aplikacije i kratak trag prethodnih događaja u aplikaciji. Ne prima vaše ime, e-poštu, poruke iz četa niti upite pretrage. [Sentry politika privatnosti](https://sentry.io/privacy/).

Naši sopstveni dijagnostički zapisi, evidencija četa i Langfuse tragovi posmatranja rade na infrastrukturi kojom sami upravljamo — oni _nisu_ podobrađivači trećih strana.

## Anonimno korišćenje

Ako koristite aplikaciju bez prijave, i dalje nam je potreban stabilan identifikator vezan samo za uređaj da bismo vas prepoznali kroz sesije (na primer, da bismo zapamtili vaše potvrde o pretplati). Taj identifikator i svi podaci na strani servera vezani za njega automatski se brišu nakon 12 meseci neaktivnosti. Ako se u bilo kom trenutku prijavite, ovi podaci postaju deo vašeg naloga i podležu pravilima _Brisanja naloga_ navedenim ispod.

## Brisanje naloga

Ako ste se prijavili putem Apple ili Google naloga, možete izbrisati svoj nalog u bilo kom trenutku iz same Aplikacije: **Podešavanja → Nalog → Izbriši nalog**. Dugme se prikazuje samo dok ste prijavljeni.

Šta brišemo sa naših servera kada dodirnete Izbriši nalog:

- Vaš nalog (id, e-pošta, ime, link profilne slike).
- Apple i Google veze za prijavu povezane sa tim nalogom.
- Sve aktivne sesije — svaki uređaj prijavljen na nalog se odjavljuje.
- Vašu istoriju četa sa našom uslugom (vaše poruke, odlomke koje smo pronašli, odgovore modela) i sve povezane brojače.

Šta ostaje na vašem uređaju — i o čemu vi odlučujete tokom toka brisanja — jesu lokalni podaci koje je Aplikacija keširala za vas: četovi, beleške, plejliste, preuzeti audio i istorija slušanja. Možete obrisati ove lokalne podatke kao deo brisanja naloga, ili ih zadržati i nastaviti da koristite Aplikaciju anonimno.

Šta ne možemo izbrisati na zahtev: poruke poslate tokom korišćenja četa putuju kroz [OpenRouter](https://openrouter.ai/privacy) ka provajderu jezičkog modela — trenutno [Google Gemini modelima](https://policies.google.com/privacy). Ti provajderi čuvaju poruke kraći period (obično do 30 dana) u skladu sa sopstvenim politikama protiv zloupotrebe. Evidencija kupovina koju Apple ili Google čuvaju tokom trajanja sopstvenih politika tih platformi takođe je izvan naše kontrole.

## Koja su moja prava na odustajanje (opt-out)?

Možete jednostavno zaustaviti svako prikupljanje informacija od strane Aplikacije tako što ćete je deinstalirati. Možete koristiti standardne procese deinstalacije dostupne kao deo vašeg mobilnog uređaja ili putem prodavnice mobilnih aplikacija ili mreže. Ako ste se prijavili putem Apple ili Google naloga, dodatno možete izbrisati svoj nalog i pridružene podatke na strani servera iz same Aplikacije — pogledajte odeljak _Brisanje naloga_ iznad. Takođe možete poslati e-poštu Pružaocu usluge na [support@jiva.studio](mailto:support@jiva.studio) za bilo koji drugi zahtev za uklanjanje podataka; imajte u vidu da se evidencija koju zahtevaju Apple ili Google za proveru kupovina ne može ukloniti tokom perioda propisanog tim platformama.

## Upravljanje pretplatom

Pretplatama u potpunosti upravljaju Apple ili Google. Da biste pregledali, otkazali ili promenili pretplatu, koristite podešavanja pretplate vašeg App Store ili Google Play naloga. Otkazivanje ne briše istoriju pretplata koju čuvaju Apple ili Google.

## Deca

Aplikacija se ne koristi za svesno prikupljanje podataka od dece mlađe od 13 godina niti za oglašavanje usmereno ka njima.

Pružalac usluge svesno ne prikuplja lično prepoznatljive informacije od dece. Pružalac usluge podstiče svu decu da nikada ne dostavljaju nikakve lično prepoznatljive informacije putem Aplikacije i/ili Usluga. Pružalac usluge podstiče roditelje i zakonske staratelje da nadgledaju korišćenje interneta od strane svoje dece i da pomognu u sprovođenju ove Politike tako što će uputiti svoju decu da nikada ne dostavljaju lično prepoznatljive informacije putem Aplikacije i/ili Usluga bez njihove dozvole. Ako imate razloga da verujete da je dete dostavilo lično prepoznatljive informacije Pružaocu usluge putem Aplikacije i/ili Usluga, molimo vas da kontaktirate Pružaoca usluge ([support@jiva.studio](mailto:support@jiva.studio)) kako bi mogao da preduzme neophodne radnje.

## Bezbednost

Pružalac usluge je posvećen zaštiti poverljivosti vaših informacija. Svi podaci preneti obrađivačima pretplata šifrovani su tokom prenosa preko HTTPS-a. Aplikacija ne čuva nikakve podatke o platnim karticama — plaćanja obrađuju isključivo Apple i Google.

## Izmene

Ova Politika privatnosti može se s vremena na vreme ažurirati iz bilo kog razloga. Pružalac usluge će vas obavestiti o svim izmenama svoje Politike privatnosti ažuriranjem ove stranice novom Politikom privatnosti. Savetuje vam se da redovno proveravate ovu Politiku privatnosti zbog eventualnih izmena, jer se nastavak korišćenja smatra prihvatanjem svih izmena.

Ova politika privatnosti stupa na snagu 18. juna 2026.

## Vaša saglasnost

Korišćenjem Aplikacije saglašavate se sa obradom vaših informacija kako je navedeno u ovoj Politici privatnosti, sada i sa izmenama koje Pružalac usluge unese.

## Kontaktirajte nas

Ako imate bilo kakvih pitanja u vezi sa privatnošću tokom korišćenja Aplikacije, ili imate pitanja o praksama, molimo vas da kontaktirate Pružaoca usluge putem e-pošte na [support@jiva.studio](mailto:support@jiva.studio).
