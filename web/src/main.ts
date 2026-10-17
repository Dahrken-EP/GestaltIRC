import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import GuestApp from './components/GuestApp.svelte'
import { guestTokenFrom } from './lib/guest/connection'
import './lib/install.svelte'

// A link from a Gestalt user opens this same page at /guest/<token>, which shows a guest's view instead of the app.
const token = guestTokenFrom(location.pathname)
const target = document.getElementById('app')!

export default token ? mount(GuestApp, { target, props: { token } }) : mount(App, { target })
