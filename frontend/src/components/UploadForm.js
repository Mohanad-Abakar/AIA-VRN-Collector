// src/components/UploadForm.js
import React, { useRef } from 'react';
// import './UploadForm.css';  ← remove or comment out this line

export default function UploadForm({ onUploadSuccess }) {
  const fileInputRef = useRef();

  const handleSubmit = async (e) => {
    e.preventDefault();
    const fileObj = fileInputRef.current.files[0];
    if (!fileObj) {
      alert('Please choose a file first.');
      return;
    }
    const formData = new FormData();
    formData.append('file', fileObj);

    try {
      const resp = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      const result = await resp.json();
      alert(`Upload complete: ${result.count} records.`);
      if (typeof onUploadSuccess === 'function') {
        onUploadSuccess();
      }
    } catch (err) {
      console.error('Upload error:', err);
      alert('Upload failed. Check console for details.');
    }
  };

  return (
    <div style={{ marginBottom: '1rem' }}>
      <form onSubmit={handleSubmit}>
        <input
          type="file"
          accept=".csv,.xlsx"
          ref={fileInputRef}
          style={{ marginRight: '0.5rem' }}
        />
        <button type="submit">Upload</button>
      </form>
    </div>
  );
}
