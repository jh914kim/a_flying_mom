/**
 * a flying mom - Custom MapLibre GL Style for OpenFreeMap
 * 
 * Based on Positron, heavily customized:
 * - Land background: #F6F5EF
 * - Water/Ocean/Lakes: #CDE5F5
 * - Park: #DCEBD4
 * - Forest/Wood: #E3EEDB
 * - Residential: #F5F2E9
 * - Glacier/Ice: #EDF5F6
 * - Country/Admin Boundary: #ABBFA9
 * - Place Name Text: #687681 (with 1.5px white halo)
 * 
 * Clutter-free: All buildings, shops, facilities, detailed roads and street labels removed.
 * Korean priority: name:ko prioritized, and non-Korean labels omitted.
 */

export const CUSTOM_MAP_STYLE = {
  version: 8,
  name: "a-flying-mom-openfreemap",
  metadata: {
    "maputnik:renderer": "mlgljs"
  },
  sources: {
    openmaptiles: {
      type: "vector",
      url: "https://tiles.openfreemap.org/planet"
    }
  },
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  layers: [
    // 1. Land Background
    {
      id: "background",
      type: "background",
      paint: {
        "background-color": "#F6F5EF"
      }
    },

    // 2. Residential areas
    {
      id: "landuse_residential",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landuse",
      filter: ["==", "class", "residential"],
      paint: {
        "fill-color": "#F5F2E9",
        "fill-opacity": 0.8
      }
    },

    // 3. Glaciers / Ice
    {
      id: "landcover_glacier",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["in", "subclass", "glacier", "ice"],
      paint: {
        "fill-color": "#EDF5F6",
        "fill-opacity": 0.9
      }
    },

    // 4. Parks
    {
      id: "landuse_park",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "park",
      paint: {
        "fill-color": "#DCEBD4",
        "fill-opacity": 0.85
      }
    },

    // 5. Forests / Woods
    {
      id: "landcover_wood",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["in", "class", "wood", "forest"],
      paint: {
        "fill-color": "#E3EEDB",
        "fill-opacity": 0.85
      }
    },

    // 6. Water Bodies (Ocean, Lakes, Reservoirs)
    {
      id: "water",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "water",
      paint: {
        "fill-color": "#CDE5F5",
        "fill-opacity": 1.0
      }
    },

    // 7. Waterway lines (major rivers)
    {
      id: "waterway",
      type: "line",
      source: "openmaptiles",
      "source-layer": "waterway",
      filter: ["in", "class", "river", "canal"],
      paint: {
        "line-color": "#CDE5F5",
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.5, 10, 2]
      }
    },

    // 8. Country and Administrative Boundaries
    {
      id: "boundary_country",
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      filter: ["==", "admin_level", 2],
      paint: {
        "line-color": "#ABBFA9",
        "line-width": ["interpolate", ["linear"], ["zoom"], 2, 1, 8, 2],
        "line-dasharray": [3, 2]
      }
    },
    {
      id: "boundary_state",
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      filter: ["==", "admin_level", 4],
      minzoom: 4,
      paint: {
        "line-color": "#ABBFA9",
        "line-width": 0.8,
        "line-dasharray": [2, 2]
      }
    },

    // 9. Country Names (Korean Priority, omit if non-Korean)
    {
      id: "place_country",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      filter: ["==", "class", "country"],
      maxzoom: 6,
      layout: {
        "text-field": [
          "case",
          ["has", "name:ko"], ["get", "name:ko"],
          ["has", "name_ko"], ["get", "name_ko"],
          // If Korean name is absent, check if native name is Hangul
          ["to-boolean", ["string", ["get", "name:ko"]]], ["get", "name:ko"],
          ""
        ],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 2, 10, 5, 14],
        "text-transform": "none",
        "text-max-width": 8
      },
      paint: {
        "text-color": "#687681",
        "text-halo-color": "#FFFFFF",
        "text-halo-width": 1.5
      }
    },

    // 10. Major City Names (Korean Priority, omit if non-Korean)
    {
      id: "place_city",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      filter: ["in", "class", "city", "capital"],
      minzoom: 3,
      maxzoom: 12,
      layout: {
        "text-field": [
          "case",
          ["has", "name:ko"], ["get", "name:ko"],
          ["has", "name_ko"], ["get", "name_ko"],
          ""
        ],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10, 8, 14],
        "text-max-width": 8
      },
      paint: {
        "text-color": "#687681",
        "text-halo-color": "#FFFFFF",
        "text-halo-width": 1.5
      }
    }
  ]
};
