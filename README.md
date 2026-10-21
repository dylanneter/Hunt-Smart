# Hunt Smart

A free hunting forecast app for private land. Pin your tree stands, then see which ones the wind favors, along with sun, moon, solunar and deer movement forecasts. It runs in your phone's browser and can be saved to your home screen like a regular app. No account, no subscription, no build step.

## Features

- **Deer movement score (0–100)** for each day and hour. It combines dawn/dusk timing, solunar periods, pressure trend, temperature swings, wind, rain, moon phase and rut timing.
- **Best windows**: the highest-scoring stretches inside legal shooting light.
- **Tree stands on a satellite map**: tap the add button, line the stand up under the crosshair and place it. Drag to move it, and mark the winds that work for it. Each stand shows a **scent cone** drawn downwind and colored green/yellow/red for the forecast hour. A slider steps through the next 7 days hour by hour.
- **Which stand to sit**: morning and evening wind ratings for every stand.
- **Stand facing & entry routes**: set which way each stand faces, draw one or more routes in from where you park, and mark bedding areas, food sources and trails. For the morning and evening walk-in times, the app scores every route by where your scent drifts as you walk (over the area in front of the stand or your marked deer sign?), flags routes that walk through bedding, and recommends the best one. Stands without routes get a suggested side to approach from.
- **Hunt log & target bucks**: log every sighting, whether from a stand, the house or the truck. Drop a pin where the deer was, set the time (you can backdate it), what it was, which named buck, what it was doing and which way it was heading. The wind, temperature, pressure trend, moon, time from sunrise/sunset and movement score are saved with it automatically while that hour is still in the forecast window (about the last 2 days). The Log tab shows your journal, a filter per buck, and a pattern summary (common winds, times, pressure, temps and travel direction) once a buck has 2+ sightings. Sightings from the last 60 days show on the map.
- **Sit log**: tap **Start a sit** when you get in the stand (it suggests the stand with the best wind and your best route in), **Saw deer** to drop a sighting pin centered on your stand, and **End** when you climb down to record bucks and does seen and whether you got busted. Each sit saves the conditions and the movement score the app predicted for that window. When you end a sit, tap **What happened** tags (bumped deer walking in, winded me, wind swirled, people/vehicles, had a shot…). Unlike notes, the app uses these: routes where you've bumped deer get flagged and downgraded in route picks, and blown walk-ins are left out of the scorecard. The Log tab's **How's the score doing?** card compares deer seen per hour on high, medium and low score sits, with stats for each stand, so you can see whether the score holds up on your property.
- **Live weather & wind**: refreshes automatically every 10 minutes while the app is open, and again when you reopen it or regain signal. A status dot shows Live / stale / offline, and a banner pops up when the wind shifts 45° or more. On the map, the slider starts at **Now** (live wind); the stand picker adds a **Right now** column.
- **Wind check**: forecasts and airport stations can miss local wind. Tap the wind dial or **Do a wind check**, tap which way a flag, smoke or milkweed is blowing *toward*, and the app uses your reading as "now" for 90 minutes (scent cones, stand ratings, routes, sits). The same sheet shows what each source says right now (nearest station with distance and age, National Blend, HRRR) and, after a few checks, how far off the forecast usually runs at your place.
- **Weather location**: the Today and Week pages show which town the weather is for. Tap it to search by town, address, ZIP code or `lat, lon`, or to use your current location.
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

1. Allow location when asked, or tap the **Weather for…** bar on the Today page and search for your property's town or address.
2. On the **Map** tab, tap the add button (square with a +), move the map so the crosshair is on your stand, and tap **Place stand here**.
3. Select the wind directions that carry your scent away from where deer approach (e.g. a stand with deer coming from the north wants S/SE/SW winds).
4. Set legal shooting light minutes and your local peak rut date under **Settings**.

## Run locally

Any static file server works:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## How the movement score works

Weights follow GPS-collar research on white-tailed deer rather than hunting folklore. Tap the **?** next to the score in the app for the same table with sources.

| Factor | Effect on score | Evidence |
| --- | --- | --- |
| Time of day (dawn & dusk) | Up to +55 | Strong: the dominant pattern in every study |
| Rut timing (from your peak rut date) | +4 to +12, plus midday movement at peak | Strong |
| Temperature change vs yesterday | +5 to +9 cold snap, −2 to −8 warm/hot | Moderate: most consistent weather effect |
| Barometric pressure trend | +2 to +3 | Mixed |
| Rain | −6 heavy, +4 after it clears | Limited |
| Solunar: moon overhead/underfoot only | +2 to +4 | Weak |
| Wind | −4 only above 25 mph | Weak (wind matters for scent, handled by stand/route ratings) |
| Moon phase | Not scored | No effect found |

Sources: [Penn State](https://www.psu.edu/news/research/story/research-focus-how-deer-respond-changes-moon-phase-weather), [Webb et al. 2010](https://doaj.org/article/98c06121b2744793be79f44614fcd27f), [Sullivan et al. 2016](https://seafwa.org/journal/2016/movement-moon-white-tailed-deer-activity-and-solunar-events), [Goethlich, Auburn](https://etd.auburn.edu/handle/10415/7077), [NC State](https://repository.lib.ncsu.edu/items/61a4d1f2-63c5-4c35-8169-e3be4adcff7d/full).

The day score blends the best morning hour, the best evening hour and the average across shooting light. Weights are set by hand from these findings, not fitted to data.

## Weather & terrain data

- **Forecast**: NOAA National Blend of Models (NBM, 2.5 km, bias-corrected) first, then NOAA HRRR (3 km, hourly) blended with GFS, via Open-Meteo. Falls back to Open-Meteo's default blend if those aren't available (e.g. outside the US).
- **Right now**: the latest reading from the nearest National Weather Service station (within 25 mi, under 90 minutes old), otherwise the model's current conditions. The Forecast page says which.
- **Terrain**: AWS Terrain Tiles (USGS 3DEP, ~10 m in the US) for elevation, slope, which way the ground faces, and whether a stand sits on high ground, a side-hill or a bottom. Thermals are modeled as a downhill pull at night, dawn and dusk and an uphill pull midday, scaled by slope, and added to the wind to get the actual scent drift used by scent cones, stand ratings and route scoring.
- **Map layers**: Satellite, Topo, Streets, USGS Topo (contours), plus a hillshade overlay.

## Credits

- Weather: [Open-Meteo](https://open-meteo.com/) (NOAA NBM, HRRR, GFS) and [National Weather Service](https://www.weather.gov/documentation/services-web-api) observations
- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (USGS 3DEP, SRTM and others); hillshade © Esri; USGS The National Map
- Sun & moon math: [SunCalc](https://github.com/mourner/suncalc) (BSD-2)
- Place search: [OpenStreetMap Nominatim](https://nominatim.org/)
- Map: [Leaflet](https://leafletjs.com/) (BSD-2), Esri World Imagery, OpenStreetMap, OpenTopoMap
