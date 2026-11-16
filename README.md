# idrive7-motordaten

**Motordaten** als App für BMW mit **iDrive 7 (MGU)** – dieselbe App wie die
Motordaten-App für den G87 M2 (iDrive 8), nur auf dem MGU App Kit. Zeigt live die
Werte der Motorsteuerung: Drehzahl, Öl-/Kühlmittel-/Ansaug-/Abgas-/Getriebe­temperatur,
Lade- und Öldruck, Last, Leistung/Drehmoment, Klopfen, Bordnetz. **Nur lesend.**

Angelegt für einen G20 (B58, Benziner G-Serie). Installiert und aktualisiert über
den [mgu-store](https://github.com/robertnisipeanu/mgu-store).

## Stand

- **Live-Seite:** fertig, 1:1 das Design der iDrive-8-App (Tab-Leiste Live /
  Maximalwerte / Logs / Fehler / Einstellungen, Drehzahlband, Gauges, Spitzenwerte).
- **In Arbeit:** die Tabs Fehler (Fehlerspeicher lesen, 19 02), Logs und
  Maximalwerte mit Live-Daten.
- **Nicht enthalten (anders als die M2-App):** Schreib-Aktionen. „Max Cooling" und
  „Fehlerspeicher löschen" schreiben ins Steuergerät – das macht diese App nicht.

## Installieren

1. Im Store: **Einstellungen → Quelle hinzufügen**, `Prototype019/idrive7-motordaten`
   eingeben, **Branch main** wählen.
2. **Motordaten** installieren, Headunit einmal neu starten, App öffnen.

## Aufbau

```
apps/km_motordaten/
  app.json        Manifest: Signale (CDS, InternalTasu), Screen, Einstellungen
  main.js         Kit-Einstieg: Werte-Loop (UDS 0x22), Render dash.js → Bild
  dme.js          (Reserve) Werte als DID-Kandidaten im Kit-Format
  md/             die Zeichen-/Logik-Module der iDrive-8-App (dash, decode,
                  limits, faults, logbook, records, kit_canvas …), 1:1 übernommen
  icon.png
kit/              MGU App Kit (fremd, MIT – siehe kit/UPSTREAM.md)
```

## Technik, kurz

Die iDrive-7-Oberfläche kennt keine App-Umgebung wie der Store sie fürs Zeichnen
braucht – deshalb zeichnet `md/dash.js` die Seiten als Bild (2880×764), das in den
ID7-Bildbereich (1600×520) eingepasst und über `ui.image` ausgegeben wird. Die
Werte liest `main.js` per UDS-Diagnose (`0x22 ReadDataByIdentifier`) aus der DME
(0x12), dem Getriebe (EGS 0x18) und einer OBD-PID – über `kit/diag.js`, dekodiert
mit `md/decode.js` (DME8FF_R, B58/B48/B38).

## Grundlagen und Lizenzen

- `kit/` – **MGU App Kit** aus
  [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
  (MIT), getrimmt; Vorlage für den App-Aufbau war dort `car_vitals`.
- `md/` – unsere eigenen Module aus
  [Prototype019/motordaten](https://github.com/Prototype019/motordaten) (iDrive-8-App).
- DID-Tabellen/Decodierung aus dem genannten `idrive7-apps`-Projekt (DME8FF_R, aus
  der öffentlichen EdiabasX-Referenz).

## Rechtliches

Arbeit am eigenen Fahrzeug, nur lesend (keine Schreibzugriffe aufs Steuergerät).
Enthält keine BMW-Software und keine Fahrzeug-Identdaten.

## Lizenz

MIT (siehe [LICENSE](LICENSE)). Das Kit unter `kit/` behält seine eigene
MIT-Lizenz (`kit/LICENSE.kit`).
