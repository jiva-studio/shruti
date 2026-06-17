A **személyes adataid** egy helyi adatbázisban élnek az eszközön. Soha nem
küldjük el szervernek. Hogy eszközök között átvihesd vagy biztonsági
mentésben megőrizhesd, az alkalmazás támogatja az exportálást és az
importálást.

## Mit tartalmaz a biztonsági mentés

A mentési fájl mindent tartalmaz, ami személyes:

- A lejátszási listádat és a benne lévő felvételek sorrendjét.
- Minden felvétel hallgatási haladását, és hogy mely felvételeket fejezted
  be.
- A jegyzeteket és könyvjelzőket.
- A letöltött felvételek nyilvántartását.
- A mentett keresési szűrőket.

A mentés **nem** tartalmazza magát az előadás-katalógust — az a
tartalomszerverről érkezik. Egy új eszközön való importálás után az
alkalmazás automatikusan letölti a katalógust.

## Exportálás

1. Nyisd meg a **Beállítások → Adatok → Felhasználói adatok exportálása**
   menüt.
2. Telefonon a rendszer megosztási lapja nyílik meg — válaszd ki, hova mentsd
   (felhőtárhely, e-mail, Fájlok stb.). A weben a böngésző elindít egy
   letöltést.
3. A fájl egy szokványos SQLite-adatbázis.

Annyiszor exportálhatsz, ahányszor csak akarsz — az exportálás semmin sem
változtat az alkalmazásban.

## Importálás

1. Nyisd meg a **Beállítások → Adatok → Felhasználói adatok importálása**
   menüt.
2. Válassz ki egy korábban exportált `.db` fájlt.
3. Erősítsd meg a lecserélési párbeszédpanelt. Az alkalmazás leállítja a
   lejátszót, az összes felhasználói táblát lecseréli a fájlban lévőre, majd
   újratölt.

> **Figyelem!** Az importálás **lecseréli** a meglévő adatokat — a
> lejátszási lista, a jegyzetek, a letöltések és a haladás, amik most az
> alkalmazásban vannak, felülíródnak. Nincs visszavonás. Ha meg szeretnéd
> tartani a jelenlegi állapotot, előbb exportáld.

## Gyorsítótár törlése vs. felhasználói adatok törlése

A **Veszélyes zónában** (csak a hibakereső szakasz feloldása után látható)
két pusztító lehetőséget találsz, amelyeket könnyű összekeverni:

- A **Gyorsítótár törlése** eltávolítja az összes letöltött hangfelvételt és
  átiratot. Nem nyúl a lejátszási listádhoz, jegyzeteidhez vagy a hallgatási
  haladásodhoz.
- A **Felhasználói adatok törlése** minden személyes táblát kitöröl —
  ugyanaz a hatása, mint egy friss telepítésnek. Az előadás-katalógus
  megmarad.

A felhasználói adatok törlése előtt mindig exportálj.
