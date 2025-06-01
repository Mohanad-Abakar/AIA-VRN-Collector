import React, { useState, useEffect } from 'react';
import './RecordsTable.css';

export default function RecordsTable({ records, onCellChange }) {
  const [localRows, setLocalRows] = useState([]);

  useEffect(() => {
    setLocalRows(records || []);
  }, [records]);

  const handleInputChange = (rowIndex, columnKey, event) => {
    const newValue = event.target.value;
    setLocalRows((prev) => {
      const updated = [...prev];
      updated[rowIndex] = { ...updated[rowIndex], [columnKey]: newValue };
      return updated;
    });
    if (typeof onCellChange === 'function') {
      onCellChange(rowIndex, columnKey, newValue);
    }
  };

  if (!Array.isArray(localRows) || localRows.length === 0) {
    return <div className="no-records">No records to display.</div>;
  }

  const columnKeys = Object.keys(localRows[0]);

  return (
    <div className="table‐wrapper">
      <table className="records‐table">
        <thead>
          <tr>
            {columnKeys.map((key) => (
              <th key={key}>{toHeaderLabel(key)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {localRows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columnKeys.map((colKey) => (
                <td key={colKey}>
                  <input
                    type="text"
                    value={row[colKey] || ''}
                    onChange={(e) => handleInputChange(rowIndex, colKey, e)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function toHeaderLabel(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
