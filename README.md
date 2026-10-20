# Hunt Smart

A free hunting forecast app for private land. Pin your tree stands, then see which ones the wind favors, along with sun, moon, solunar and deer movement forecasts. It runs in your phone's browser and can be saved to your home screen like a regular app. No account, no subscription, no build step.

## Features

- **Deer movement score (0–100)** for each day and hour. It combines dawn/dusk timing, solunar periods, pressure trend, temperature swings, wind, rain, moon phase and rut timing.
- **Best windows**: the highest-scoring stretches inside legal shooting light.
- **Tree stands on a satellite map**: tap to add a stand, drag to move it, and mark the winds that work for it. Each stand shows a **scent cone** drawn downwind and colored green/yellow/red for the forecast hour. A slider steps through the next 7 days hour by hour.
- **Which stand to sit**: morning and evening wind ratings for every stand.
- **Live weather & wind**: refreshes automatically every 10 minutes while the app is open, and again when you reopen it or regain signal. A status dot shows Live / stale / offline, and a banner pops up when the wind shifts 45° or more. On the map, the slider starts at **Now** (live wind); the stand picker adds a **Right now** column.
- **Weather & wind**: hourly strip, morning/evening sit winds, gusts, precipitation and humidity.
- **Sun**: legal light start/end (adjustable for your state), sunrise, sunset, solar noon.
- **Moon**: phase, illumination, moonrise/set, and moon overhead/underfoot.
- **Solunar feeding times**: major and minor periods, flagged when they line up with sunrise or sunset.
- **Pressure trend chart** and **scent/thermal guidance** for the day.
- **7-day outlook**.
- **Works with weak signal**: the last forecast and the map tiles you've viewed are saved on the phone.
- **Backup/share**: export your stands to a file and import it on your hunting partner's phone.

All data stays on your phone (browser local storage).

## Put it on your phone

The app has to be hosted somewhere your phone can reach. GitHub Pages is free:

1. On GitHub, open the repo → **Settings → Pages**.
2. Under *Build and deployment*, choose **Deploy from a branch**. Pick the branch (e.g. `main`) and the `/ (root)` folder, then save.
3. After a minute the site will be live at `https://<your-username>.github.io/<repo-name>/`.
4. Open that link on your phone:
   - **iPhone (Safari):** Share button → **Add to Home Screen**
   - **Android (Chrome):** ⋮ menu → **Add to Home screen** / **Install app**

GitHub Pages on a free account requires the repository to be public.

## First-time setup

1. Allow location when asked, or enter your property's coordinates under **Stands → Settings**.
2. On the **Map** tab, tap **+ Add stand**, then tap the stand's spot on the map.
3. Select the wind directions that carry your scent away from where deer approach (e.g. a stand with deer coming from the north wants S/SE/SW winds).
4. Set legal shooting light minutes and your local peak rut date under **Settings**.

## Run locally

Any static file server works:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## How the movement score works

Each hour starts from a base curve that peaks just after sunrise and just before sunset. Adjustments:

| Factor | Effect |
| --- | --- |
| Solunar major / minor period | +14 / +8 |
| Pressure rising after a front | +7; fast fall ahead of a storm +5 |
| 10°F+ colder than the same hour yesterday | +10 (5°F: +5); warm swings subtract |
| Hot (>65°F / >75°F) | −5 / −10 |
| Wind >14 mph / >20 mph | −8 / −15 |
| Heavy rain | −12; first hours after rain stops +8 |
| Near new or full moon | +3 |
| Rut phase (from your peak rut date) | +4 to +12, plus midday movement during the peak |

The day score blends the best morning hour, the best evening hour and the average across shooting light. These weights are rules of thumb, not a guarantee, so use them to compare days.

## Credits

- Weather: [Open-Meteo](https://open-meteo.com/) (free, no API key)
- Sun & moon math: [SunCalc](https://github.com/mourner/suncalc) (BSD-2)
- Map: [Leaflet](https://leafletjs.com/) (BSD-2), Esri World Imagery, OpenStreetMap, OpenTopoMap
