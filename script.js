// ----- MODE STATE -----
var editingEnabled = false;
var viewModeBtn = document.getElementById('viewModeBtn');
var editModeBtn = document.getElementById('editModeBtn');
var modeLabel = document.getElementById('modeLabel');
var controlsDiv = document.getElementById('controls');

function setMode(mode) {
  if (mode === 'view') {
    editingEnabled = false;
    controlsDiv.classList.add('hidden');
    modeLabel.textContent = 'Mode: View';
    viewModeBtn.style.background = '#555';
    editModeBtn.style.background = '#007bff';
  } else {
    editingEnabled = true;
    controlsDiv.classList.remove('hidden');
    modeLabel.textContent = 'Mode: Edit';
    viewModeBtn.style.background = '#555';
    editModeBtn.style.background = '#28a745';
  }
}

viewModeBtn.addEventListener('click', function () {
  setMode('view');
});
editModeBtn.addEventListener('click', function () {
  setMode('edit');
});

// default mode = View
setMode('view');

// 1. Initialize map centered on NYC
var map = L.map('map').setView([40.7128, -74.0060], 11);

// 2. Base tiles
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19
}).addTo(map);

// 3. URLs
var csvUrl =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vTgzbXe5vjM3Jj-Pi8nfxk0G4FZkLWuAnOckzQp4HbHYUYU2MGyV11OLfL1jfNXNuaIxsCRd3-86n_x/pub?gid=0&single=true&output=csv';
// Change this when updating web app
var scriptUrl = 'https://script.google.com/macros/s/AKfycbxjQdsxCqsVf1u5SuF-hFKL4WnE-R232tiwnWh4SQytt37fPY8Z9Us97jqV8bgKmnyFGg/exec';

// --- State for IDs and markers ---
var locationsById = {};   // id -> { id, name, hub, addr, lat, lng, viability, notes, expecting }
var markersById = {};     // id -> Leaflet marker
var nextId = 1;           // auto-increment seed
var currentEditingId = null;

// --- Driver color mapping (dynamic, up to 4 colors reused) ---
var DRIVER_COLOR_ORDER = ['driver-blue', 'driver-pink', 'driver-red', 'driver-green'];
var driverColorMap = {};   // driverName(lowercased) -> class
var driverColorIndex = 0;  // which color to assign next

function getDriverClass(driverValue) {
  if (!driverValue) return '';
  var key = driverValue.toString().trim().toLowerCase();
  if (!key) return '';

  if (!driverColorMap[key]) {
    // assign next color in cycle
    var colorClass = DRIVER_COLOR_ORDER[driverColorIndex % DRIVER_COLOR_ORDER.length];
    driverColorMap[key] = colorClass;
    driverColorIndex++;
  }
  return driverColorMap[key];
}

function makeDriverIcon(loc) {
  var expectingRaw = (loc.expecting || '').toLowerCase();
  var hubRaw = (loc.hub || '').toLowerCase();

  var expectingYes =
    expectingRaw === 'yes' ||
    expectingRaw === 'y'   ||
    expectingRaw === 'true'||
    expectingRaw === '1';

  var isHub = hubRaw === 'yes';

  var statusClass = 'not-expecting';
  if (isHub) {
    statusClass = 'hub';
  } else if (expectingYes) {
    statusClass = 'expecting';
  }

  var driverClass = getDriverClass(loc.driver);  // this is the important line

  return L.divIcon({
    className: 'ua3-marker ' + statusClass + ' ' + driverClass,
    iconSize: [24, 24],
    iconAnchor: [12, 24],
    popupAnchor: [0, -24],
    html: '<div class="marker-circle"><div class="driver-dot"></div></div>'
  });
}

// --- CSV line splitter ---
function splitCsvLine(line) {
  var cols = [];
  var current = '';
  var inQuotes = false;

  for (var i = 0; i < line.length; i++) {
    var ch = line[i];

    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cols.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cols.push(current);
  return cols;
}

// Draw marker with Edit/Delete buttons in popup + driver-colored dot
function drawMarker(loc) {
  var popupHtml =
    '<b>ID ' + loc.id + ' — ' + (loc.name || 'Unnamed location') + '</b><br>' +
    (loc.addr ? loc.addr + '<br>' : '') +
    (loc.viability ? 'Viability: ' + loc.viability + ' / 10<br>' : '') +
    (loc.notes ? 'Notes: ' + loc.notes + '<br>' : '') +
    'Hub: ' + (loc.hub || '') + '<br>' +
    'Expecting Load: ' + (loc.expecting || '') + '<br>' +
    'Driver: ' + (loc.driver || 'Unassigned') + '<br>' +
    '<button type="button" class="edit-marker-btn" data-id="' + loc.id + '">Edit</button> ' +
    '<button type="button" class="delete-marker-btn" data-id="' + loc.id + '">Delete</button>';

  var marker = L.marker([loc.lat, loc.lng], {
    icon: makeDriverIcon(loc)
  }).addTo(map);

  marker.bindPopup(popupHtml);
  markersById[loc.id] = marker;
}

// 6. Load existing points from sheet
function loadMarkersFromSheet() {
  fetch(csvUrl)
    .then(function (res) { return res.text(); })
    .then(function (text) {
      var lines = text
        .replace(/\r/g, '')
        .split('\n')
        .filter(function (l) { return l.trim() !== ''; });

      if (lines.length < 2) return;

      // Remove old markers from map
      for (var id in markersById) {
        if (markersById.hasOwnProperty(id)) {
          map.removeLayer(markersById[id]);
        }
      }
      markersById = {};
      locationsById = {};

      // Reset driver color mapping so legend stays in sync
      driverColorMap = {};
      driverColorIndex = 0;

      var maxExistingId = 0;

      // line 0 = header
      for (var i = 1; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;

        var cols = splitCsvLine(line);

        // 0: ID, 1: Location, 2: Hub, 3: Address, 4: Lat, 5: Lng,
        // 6: Viability, 7: Notes, 8: Expecting, 9: Driver
        var id        = parseInt((cols[0] || '').trim(), 10);
        var name      = (cols[1] || '').trim();
        var hubVal    = (cols[2] || '').trim();
        var addr      = (cols[3] || '').trim();
        var lat       = parseFloat(cols[4]);
        var lng       = parseFloat(cols[5]);
        var viability = (cols[6] || '').trim();
        var notes     = (cols[7] || '').trim();
        var expecting = (cols[8] || '').trim();
        var driver    = (cols[9] || '').trim();

        // Fallback for old format (no ID/Driver columns)
        if (isNaN(lat) || isNaN(lng)) {
          name      = (cols[0] || '').trim();
          hubVal    = (cols[1] || '').trim();
          addr      = (cols[2] || '').trim();
          lat       = parseFloat(cols[3]);
          lng       = parseFloat(cols[4]);
          viability = (cols[5] || '').trim();
          notes     = (cols[6] || '').trim();
          expecting = (cols[7] || '').trim();
          driver    = ''; // old rows had no driver column
        }

        if (isNaN(lat) || isNaN(lng)) continue;

        if (!id || isNaN(id)) {
          maxExistingId += 1;
          id = maxExistingId;
        } else if (id > maxExistingId) {
          maxExistingId = id;
        }

        var loc = {
          id: id,
          name: name,
          hub: hubVal,
          addr: addr,
          lat: lat,
          lng: lng,
          viability: viability,
          notes: notes,
          expecting: expecting,
          driver: driver
        };

        locationsById[id] = loc;
        drawMarker(loc);
      }

      nextId = maxExistingId + 1;
      if (nextId < 1) nextId = 1;

      // Update the driver legend after colors have been (re)assigned
      refreshDriverLegend();
    })
    .catch(function (err) {
      console.error('Error loading CSV', err);
    });
}

// FIRST LOAD
loadMarkersFromSheet();

// AUTO-REFRESH MARKERS EVERY 15 SECONDS, BUT ONLY IN VIEW MODE
setInterval(function () {
  if (!editingEnabled && currentEditingId == null) {
    loadMarkersFromSheet();
  }
}, 15000);

// 7. Click handling to set lat/lng for new point (only in edit mode)
var lastClickedLatLng = null;
var latInput = document.getElementById('latInput');
var lngInput = document.getElementById('lngInput');
var statusEl = document.getElementById('status');
var driverInput = document.getElementById('driverInput');

map.on('click', function(e) {
  if (!editingEnabled) {
    return;
  }
  lastClickedLatLng = e.latlng;
  latInput.value = lastClickedLatLng.lat.toFixed(6);
  lngInput.value = lastClickedLatLng.lng.toFixed(6);
  currentEditingId = null;
  statusEl.textContent = 'Location selected on map for a NEW record.';
  statusEl.style.color = 'black';
});

// 7b. Handle popup Edit/Delete buttons
map.on('popupopen', function(e) {
  var popupEl = e.popup.getElement();
  if (!popupEl) return;

  var editBtn = popupEl.querySelector('.edit-marker-btn');
  var deleteBtn = popupEl.querySelector('.delete-marker-btn');

  if (editBtn) {
    if (!editingEnabled) {
      editBtn.style.display = 'none';
    }
    editBtn.onclick = function() {
      var id = parseInt(this.getAttribute('data-id'), 10);
      var loc = locationsById[id];
      if (!loc) return;

      if (!editingEnabled) {
        statusEl.textContent = 'Switch to Edit Mode to edit markers.';
        statusEl.style.color = 'red';
        return;
      }

      document.getElementById('locationInput').value = loc.name;
      document.getElementById('hubInput').value = loc.hub || 'No';
      document.getElementById('addressInput').value = loc.addr;
      document.getElementById('viabilityInput').value = loc.viability;
      document.getElementById('notesInput').value = loc.notes;
      document.getElementById('expectingInput').value = loc.expecting || 'No';
      driverInput.value = loc.driver || '';

      lastClickedLatLng = L.latLng(loc.lat, loc.lng);
      latInput.value = loc.lat.toFixed(6);
      lngInput.value = loc.lng.toFixed(6);

      currentEditingId = id;
      statusEl.textContent = 'Editing existing ID ' + id + '. Submitting will UPDATE this row.';
      statusEl.style.color = 'black';
    };
  }

  if (deleteBtn) {
    if (!editingEnabled) {
      deleteBtn.style.display = 'none';
    }
    deleteBtn.onclick = function() {
      var id = parseInt(this.getAttribute('data-id'), 10);
      var loc = locationsById[id];
      if (!loc) return;

      if (!editingEnabled) {
        statusEl.textContent = 'Switch to Edit Mode to delete markers.';
        statusEl.style.color = 'red';
        return;
      }

      if (markersById[id]) {
        map.removeLayer(markersById[id]);
        delete markersById[id];
      }
      delete locationsById[id];

      fetch(scriptUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', ID: id })
      }).catch(function(err) {
        console.error('Delete error', err);
      });

      statusEl.textContent = 'Deleted ID ' + id + ' from sheet (and map).';
      statusEl.style.color = 'black';
    };
  }
});

// 8. Form submit → ADD or UPDATE based on currentEditingId
document.getElementById('addBtn').addEventListener('click', function() {
  statusEl.textContent = '';

  if (!editingEnabled) {
    statusEl.textContent = 'Switch to Edit Mode to add/edit locations.';
    statusEl.style.color = 'red';
    return;
  }

  if (!lastClickedLatLng) {
    statusEl.textContent = 'Click on the map first to choose Lat/Lng.';
    statusEl.style.color = 'red';
    return;
  }

  var locationName = document.getElementById('locationInput').value.trim();
  var hubVal       = document.getElementById('hubInput').value;
  var addressVal   = document.getElementById('addressInput').value.trim();
  var viabilityVal = document.getElementById('viabilityInput').value.trim();
  var notesVal     = document.getElementById('notesInput').value.trim();
  var expectingVal = document.getElementById('expectingInput').value;
  var driverVal    = driverInput.value.trim();

  if (!locationName) {
    statusEl.textContent = 'Location name is required.';
    statusEl.style.color = 'red';
    return;
  }

  var isUpdate = currentEditingId != null;
  var id = isUpdate ? currentEditingId : nextId;

  var payload = {
    action: isUpdate ? 'update' : 'add',
    ID: id,
    Location: locationName,
    Hub: hubVal,
    Address: addressVal,
    Lat: lastClickedLatLng.lat,
    Lng: lastClickedLatLng.lng,
    Viability: viabilityVal,
    Notes: notesVal,
    ExpectingLoad: expectingVal,
    Driver: driverVal
  };

  statusEl.textContent = (isUpdate ? 'Updating' : 'Adding') + ' ID ' + id + '...';
  statusEl.style.color = 'black';

  fetch(scriptUrl, {
    method: 'POST',
    mode: 'no-cors',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  }).then(function() {
    var loc = {
      id: id,
      name: locationName,
      hub: hubVal,
      addr: addressVal,
      lat: lastClickedLatLng.lat,
      lng: lastClickedLatLng.lng,
      viability: viabilityVal,
      notes: notesVal,
      expecting: expectingVal,
      driver: driverVal
    };
    locationsById[id] = loc;

    if (isUpdate && markersById[id]) {
      map.removeLayer(markersById[id]);
      delete markersById[id];
    } else if (!isUpdate) {
      nextId += 1;
    }

    drawMarker(loc);

    currentEditingId = null;
    statusEl.textContent = (isUpdate ? 'Updated' : 'Added') + ' ID ' + id + '. (Sheet should reflect this.)';
    statusEl.style.color = 'green';
  }).catch(function(err) {
    console.error(err);
    statusEl.textContent = 'Error submitting. See console.';
    statusEl.style.color = 'red';
  });
});

// 9. Legend for colors
var legend = L.control({ position: 'bottomright' });

legend.onAdd = function(map) {
  var div = L.DomUtil.create('div', 'legend');

  div.innerHTML =
    '<strong>Key</strong><br>' +
    '<div class="legend-item">' +
      '<span class="legend-color" style="background: orange;"></span>' +
      'Hub' +
    '</div>' +
    '<div class="legend-item">' +
      '<span class="legend-color" style="background: green;"></span>' +
      'Expecting load' +
    '</div>' +
    '<div class="legend-item">' +
      '<span class="legend-color" style="background: gray;"></span>' +
      'Not expecting load' +
    '</div>';

  return div;
};

legend.addTo(map);

// ----- DRIVER COLOR LEGEND -----
var driverLegend = L.control({ position: 'bottomright' });
var driverLegendDiv = null;

driverLegend.onAdd = function(map) {
  driverLegendDiv = L.DomUtil.create('div', 'legend');
  driverLegendDiv.innerHTML = '<strong>Driver Colors</strong><br>';
  return driverLegendDiv;
};

driverLegend.addTo(map);

// Function to update legend contents AFTER loading drivers
function refreshDriverLegend() {
  if (!driverLegendDiv) return;

  driverLegendDiv.innerHTML = '<strong>Driver Colors</strong><br>';

  var colorMap = {
    'driver-blue':  '#007bff',
    'driver-pink':  '#d543bd',
    'driver-red':   '#dc3545',
    'driver-green': '#28a745'
  };

  // Populate names + colors
  for (var driverName in driverColorMap) {
    var colorClass = driverColorMap[driverName];
    var color = colorMap[colorClass] || '#999999';

    driverLegendDiv.innerHTML +=
      '<div class="legend-item">' +
      '<span class="driver-legend-color" style="background:' + color + ';"></span>' +
      driverName +
      '</div>';
  }
}

// Optional full-page auto-refresh (commented out)
/*
setInterval(function() {
  location.reload();
}, 30000);
*/
