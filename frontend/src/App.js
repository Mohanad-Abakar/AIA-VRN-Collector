// src/App.js

import React, { useState, useEffect } from 'react';
import RecordsTable from './components/RecordsTable';
import UploadForm from './components/UploadForm';
import './App.css';

function App() {
  const [records, setRecords] = useState([]);

  // 1) On mount, fetch all records from /api/allRecords
  useEffect(() => {
    fetch('/api/allRecords')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setRecords(data);
      })
      .catch((err) => {
        console.error('Error fetching /api/allRecords:', err);
      });
  }, []);

  // 2) Called when a cell in the table is edited
  const onCellChange = (rowIndex, columnKey, newValue) => {
    // Update React state immediately
    setRecords((prev) => {
      const copy = [...prev];
      copy[rowIndex] = { ...copy[rowIndex], [columnKey]: newValue };
      return copy;
    });

    // Then send a PATCH to /api/updateRecord/:bookingId
    const bookingId = records[rowIndex].bookingId;
    fetch(`/api/updateRecord/${bookingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [columnKey]: newValue }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Patch failed ${res.status}`);
        return res.json();
      })
      .then((resp) => {
        // Optionally you can console.log(resp.updated)
      })
      .catch((err) => {
        console.error('Error patching /api/updateRecord:', err);
      });
  };

  // 3) Reload the data from /api/allRecords
  const reloadData = () => {
    fetch('/api/allRecords')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        return res.json();
      })
      .then((updated) => {
        setRecords(updated);
      })
      .catch((err) => {
        console.error('Error reloading /api/allRecords:', err);
      });
  };

  return (
    <div
      className="App"
      style={{ padding: '1rem', fontFamily: 'Arial, sans-serif' }}
    >
      <h1>Holiday Extras – AI Assistant VRN Collector</h1>

      <section style={{ marginBottom: '2rem' }}>
        <h2>1. Upload Spreadsheet</h2>
        <UploadForm onUploadSuccess={reloadData} />
      </section>

      <section style={{ marginBottom: '2rem' }}>
        <h2>2. Process &amp; Make Calls</h2>
        <button
          onClick={() => {
            fetch('/api/process', { method: 'POST' })
              .then((res) => {
                if (!res.ok) throw new Error(`HTTP error ${res.status}`);
                return res.json();
              })
              .then((result) => {
                console.log('Calls queued:', result.callsQueued);
                reloadData();
              })
              .catch(console.error);
          }}
        >
          Process &amp; Call
        </button>
        {/* Download CSV: the browser will navigate to /api/download and download the file */}
        {/* instead, use a simple anchor tag that opens in a new tab */}
        {/* after: point directly to port 4000 */}
        <a
          href="http://localhost:4000/api/download"
          target="_blank"
          rel="noopener noreferrer"
          style={{ marginLeft: '1rem', textDecoration: 'none' }}
        >
          <button>Download CSV</button>
        </a>
      </section>

      <section>
        <h2>3. Live Call Status &amp; Data</h2>
        <RecordsTable records={records} onCellChange={onCellChange} />
      </section>
    </div>
  );
}

export default App;
