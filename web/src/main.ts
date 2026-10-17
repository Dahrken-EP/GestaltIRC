import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import './lib/install.svelte'

export default mount(App, { target: document.getElementById('app')! })
