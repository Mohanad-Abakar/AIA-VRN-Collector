// src/index.js

import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css'; // import the global styles
import App from './App'; // import the main App component

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
