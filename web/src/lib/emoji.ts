// The emoji picker's data and search. It is a curated set of the common ones, kept in the page so the picker
// works offline and asks nothing of anyone. Each line is "emoji name words", with extra search words after the name.

export interface Emoji {
  char: string
  name: string
  /** Extra words that find it. */
  words: string
  group: string
}

const SOURCE: Record<string, string> = {
  Smileys: `
😀|grinning face|happy smile
😃|grinning face with big eyes|happy
😄|grinning face with smiling eyes|happy
😁|beaming face|grin
😆|grinning squinting face|laugh
😅|grinning face with sweat|nervous
😂|face with tears of joy|lol laugh funny
🤣|rolling on the floor laughing|rofl lmao
🙂|slightly smiling face|smile
🙃|upside-down face|silly
😉|winking face|wink
😊|smiling face with smiling eyes|blush
😇|smiling face with halo|angel
🥰|smiling face with hearts|love
😍|smiling face with heart-eyes|love
🤩|star-struck|wow
😘|face blowing a kiss|kiss
😋|face savoring food|yum
😛|face with tongue|silly
😜|winking face with tongue|silly
🤪|zany face|crazy
🤔|thinking face|hmm
🤨|face with raised eyebrow|doubt
😐|neutral face|meh
😑|expressionless face|blank
😶|face without mouth|silent
🙄|face with rolling eyes|eyeroll
😏|smirking face|smirk
😒|unamused face|bored
😬|grimacing face|awkward
😌|relieved face|calm
😔|pensive face|sad
😴|sleeping face|zzz tired
🤤|drooling face|want
😷|face with medical mask|sick
🤒|face with thermometer|ill
🤕|face with head-bandage|hurt
🤢|nauseated face|gross
🤮|face vomiting|sick
🥵|hot face|heat
🥶|cold face|freezing
🥴|woozy face|drunk
😵|dizzy face|knocked out
🤯|exploding head|mind blown
🥳|partying face|celebrate party
😎|smiling face with sunglasses|cool
🤓|nerd face|geek
🧐|face with monocle|inspect
😕|confused face|puzzled
😟|worried face|anxious
😮|face with open mouth|surprised
😲|astonished face|shock
😳|flushed face|embarrassed
🥺|pleading face|please puppy
😢|crying face|sad tear
😭|loudly crying face|sob
😱|face screaming in fear|scared
😖|confounded face|frustrated
😞|disappointed face|let down
😤|face with steam from nose|angry proud
😡|pouting face|angry mad
🤬|face with symbols on mouth|swearing
💀|skull|dead
💩|pile of poo|poop
🤡|clown face|clown
👻|ghost|spooky
👽|alien|ufo
🤖|robot|bot
🙈|see-no-evil monkey|monkey
🙉|hear-no-evil monkey|monkey
🙊|speak-no-evil monkey|monkey
`,
  People: `
👍|thumbs up|yes approve like
👎|thumbs down|no dislike
👌|OK hand|okay perfect
✌️|victory hand|peace
🤞|crossed fingers|luck hope
🤟|love-you gesture|rock
🤘|sign of the horns|rock metal
🤙|call me hand|phone
👈|backhand index pointing left|left
👉|backhand index pointing right|right
👆|backhand index pointing up|up
👇|backhand index pointing down|down
☝️|index pointing up|one
✋|raised hand|stop high five
🖐️|hand with fingers splayed|hand
👋|waving hand|hello bye
🤝|handshake|deal agree
👏|clapping hands|applause bravo
🙌|raising hands|hooray praise
👐|open hands|hug
🙏|folded hands|please thanks pray
💪|flexed biceps|strong muscle
🫶|heart hands|love
✍️|writing hand|write
🤳|selfie|phone
👀|eyes|look watching
👂|ear|listen
🧠|brain|smart
🫡|saluting face|salute
🤷|person shrugging|shrug idk
🤦|person facepalming|facepalm
🙋|person raising hand|question
💁|person tipping hand|sassy
🙅|person gesturing no|no
🙆|person gesturing ok|ok
🚶|person walking|walk
🏃|person running|run
💃|woman dancing|dance
🕺|man dancing|dance
👶|baby|child
🧑‍💻|technologist|developer programmer
🧑‍🚀|astronaut|space
`,
  Hearts: `
❤️|red heart|love
🧡|orange heart|love
💛|yellow heart|love
💚|green heart|love
💙|blue heart|love
💜|purple heart|love
🖤|black heart|love
🤍|white heart|love
💔|broken heart|sad
💕|two hearts|love
💖|sparkling heart|love
💗|growing heart|love
💘|heart with arrow|cupid
💝|heart with ribbon|gift
❣️|heart exclamation|love
💯|hundred points|perfect 100
💢|anger symbol|mad
💥|collision|boom
💫|dizzy|star
💦|sweat droplets|water
💨|dashing away|wind fast
💬|speech balloon|chat
💭|thought balloon|think
💤|zzz|sleep
✨|sparkles|shiny new
⭐|star|favourite
🌟|glowing star|shine
🔥|fire|hot lit
⚡|high voltage|lightning
🎉|party popper|celebrate tada
🎊|confetti ball|celebrate
✅|check mark button|done yes
❌|cross mark|no wrong
⚠️|warning|careful
❓|question mark|what
❗|exclamation mark|important
➕|plus|add
➖|minus|remove
🔴|red circle|record
🟢|green circle|ok
🔵|blue circle|dot
`,
  Animals: `
🐶|dog face|puppy
🐱|cat face|kitten
🐭|mouse face|mouse
🐹|hamster|pet
🐰|rabbit face|bunny
🦊|fox|fox
🐻|bear|bear
🐼|panda|panda
🐨|koala|koala
🐯|tiger face|tiger
🦁|lion|lion
🐮|cow face|cow
🐷|pig face|pig
🐸|frog|frog
🐵|monkey face|monkey
🐔|chicken|chicken
🐧|penguin|linux
🐦|bird|tweet
🦆|duck|duck
🦉|owl|owl
🦇|bat|bat
🐺|wolf|wolf
🐴|horse face|horse
🦄|unicorn|unicorn
🐝|honeybee|bee
🐛|bug|insect
🦋|butterfly|butterfly
🐌|snail|slow
🐞|lady beetle|ladybug
🐢|turtle|slow
🐍|snake|python
🐙|octopus|octopus
🦀|crab|crab rust
🐠|tropical fish|fish
🐬|dolphin|dolphin
🐳|spouting whale|whale
🦈|shark|shark
🐘|elephant|elephant
🦒|giraffe|giraffe
🐿️|chipmunk|squirrel
🌵|cactus|desert
🌲|evergreen tree|tree
🌳|deciduous tree|tree
🌴|palm tree|beach
🌱|seedling|plant
🍀|four leaf clover|luck
🌸|cherry blossom|flower
🌹|rose|flower
🌻|sunflower|flower
🌈|rainbow|rain
☀️|sun|sunny
🌙|crescent moon|night
☁️|cloud|weather
🌧️|cloud with rain|rain
❄️|snowflake|cold
🌊|water wave|sea
`,
  Food: `
🍎|red apple|fruit
🍐|pear|fruit
🍊|tangerine|orange fruit
🍋|lemon|fruit
🍌|banana|fruit
🍉|watermelon|fruit
🍇|grapes|fruit
🍓|strawberry|fruit
🍒|cherries|fruit
🍑|peach|fruit
🥭|mango|fruit
🍍|pineapple|fruit
🥥|coconut|fruit
🥝|kiwi fruit|fruit
🍅|tomato|vegetable
🥑|avocado|vegetable
🥦|broccoli|vegetable
🥕|carrot|vegetable
🌽|ear of corn|corn
🌶️|hot pepper|spicy
🥔|potato|chips
🍞|bread|toast
🥐|croissant|bread
🧀|cheese wedge|cheese
🍳|cooking|egg frying
🥓|bacon|bacon
🍔|hamburger|burger
🍟|french fries|chips
🍕|pizza|pizza
🌭|hot dog|sausage
🌮|taco|mexican
🌯|burrito|wrap
🥗|green salad|salad
🍝|spaghetti|pasta
🍜|steaming bowl|noodles ramen
🍣|sushi|fish
🍤|fried shrimp|prawn
🍦|soft ice cream|ice cream
🍩|doughnut|donut
🍪|cookie|biscuit
🎂|birthday cake|cake
🍰|shortcake|cake
🍫|chocolate bar|chocolate
🍬|candy|sweet
🍿|popcorn|movie
☕|hot beverage|coffee tea
🍵|teacup without handle|tea
🍺|beer mug|beer pub
🍻|clinking beer mugs|cheers
🍷|wine glass|wine
🥂|clinking glasses|cheers
🍸|cocktail glass|drink
🧃|beverage box|juice
🥤|cup with straw|soda
`,
  Activity: `
⚽|soccer ball|football
🏀|basketball|ball
🏈|american football|ball
⚾|baseball|ball
🎾|tennis|ball
🏐|volleyball|ball
🏓|ping pong|table tennis
🎱|pool 8 ball|billiards
🎯|bullseye|target dart
🎮|video game|controller gaming
🕹️|joystick|game
🎲|game die|dice
♟️|chess pawn|chess
🎰|slot machine|casino
🎳|bowling|bowling
🏆|trophy|win prize
🥇|first place medal|gold win
🥈|second place medal|silver
🥉|third place medal|bronze
🎸|guitar|music rock
🎹|musical keyboard|piano
🥁|drum|music
🎤|microphone|sing karaoke
🎧|headphone|music
🎵|musical note|music
🎶|musical notes|music
🎬|clapper board|film
🎨|artist palette|art
📚|books|read
🎓|graduation cap|school
`,
  Travel: `
🚗|automobile|car
🚕|taxi|cab
🚌|bus|bus
🚑|ambulance|emergency
🚒|fire engine|fire
🚓|police car|police
🚲|bicycle|bike
🏍️|motorcycle|bike
🚂|locomotive|train
🚀|rocket|launch space ship it
✈️|airplane|flight
🚁|helicopter|flight
⛵|sailboat|boat
🚢|ship|boat
⚓|anchor|boat
🏠|house|home
🏢|office building|work
🏥|hospital|health
🏫|school|school
🏰|castle|castle
🗼|tokyo tower|tower
🗽|statue of liberty|usa
⛰️|mountain|hill
🏖️|beach with umbrella|holiday
🌍|globe showing europe-africa|world earth
🌎|globe showing americas|world earth
🌏|globe showing asia-australia|world earth
🌐|globe with meridians|internet web
🗺️|world map|map
🧭|compass|navigate
⏰|alarm clock|time
⌛|hourglass done|time wait
📍|round pushpin|location
`,
  Objects: `
💻|laptop|computer
🖥️|desktop computer|computer
⌨️|keyboard|type
🖱️|computer mouse|mouse
💾|floppy disk|save
💿|optical disk|cd
📱|mobile phone|phone
☎️|telephone|call
📞|telephone receiver|call
📷|camera|photo
📹|video camera|video
🎥|movie camera|film
📺|television|tv
📻|radio|radio
🔋|battery|power
🔌|electric plug|power
💡|light bulb|idea
🔦|flashlight|torch
🔍|magnifying glass tilted left|search find
🔒|locked|secure private
🔓|unlocked|open
🔑|key|password
🛡️|shield|security protect
🔧|wrench|tool fix
🔨|hammer|tool build
⚙️|gear|settings
🧰|toolbox|tools
🧪|test tube|experiment
🔬|microscope|science
🔭|telescope|space
💰|money bag|rich
💸|money with wings|spend
💳|credit card|pay
📦|package|box ship
📬|open mailbox with raised flag|mail
✉️|envelope|email
📝|memo|note write
📄|page facing up|document
📁|file folder|folder
📅|calendar|date
📌|pushpin|pin
📎|paperclip|attach
✂️|scissors|cut
🗑️|wastebasket|delete trash
🔔|bell|notification
🔕|bell with slash|mute
📢|loudspeaker|announce
🏷️|label|tag
🎁|wrapped gift|present
🧸|teddy bear|toy
🪄|magic wand|magic
🧲|magnet|attract
`,
}

export const GROUPS = Object.keys(SOURCE)

export const EMOJI: Emoji[] = Object.entries(SOURCE).flatMap(([group, text]) =>
  text
    .trim()
    .split('\n')
    .map((line) => {
      const [char, name, words = ''] = line.split('|')
      return { char: char!, name: name!, words, group }
    }),
)

/** Emoji whose name or words contain every word typed, best matches first. */
export function searchEmoji(query: string, limit = 80): Emoji[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const scored: Array<[number, Emoji]> = []
  for (const e of EMOJI) {
    const name = e.name.toLowerCase()
    const words = e.words.toLowerCase()
    let score = 0
    let ok = true
    for (const t of terms) {
      if (name === t) score += 10
      else if (name.split(' ').some((w) => w === t)) score += 6
      else if (name.startsWith(t)) score += 5
      else if (words.split(' ').some((w) => w === t)) score += 4
      else if (name.includes(t) || words.includes(t)) score += 2
      else {
        ok = false
        break
      }
    }
    if (ok) scored.push([score, e])
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, e]) => e)
}

const RECENT_KEY = 'irc:emoji-recent'
const MAX_RECENT = 24

export function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

/** Puts `char` first among the recently used, and returns the new list. */
export function rememberEmoji(char: string): string[] {
  const next = [char, ...loadRecent().filter((c) => c !== char)].slice(0, MAX_RECENT)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // not remembered
  }
  return next
}
