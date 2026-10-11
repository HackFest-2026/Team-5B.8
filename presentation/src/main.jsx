import React from 'react';
import { createRoot } from 'react-dom/client';
import './deck.css';
import App from './App.jsx';
try{ if(new URLSearchParams(location.search).has('still')) document.body.classList.add('still'); }catch(e){}
createRoot(document.getElementById('root')).render(<App />);
