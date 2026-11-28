# The 8 enemies. id -> master sprite, height in game units (Zee = 132), and whether they can grab and throw Zee.
# Raw ChatGPT sheets live in sprites/agents/raw/<id>_<sheet>.png ; build with: tools\build-enemy.ps1 -Id navy
$enemies = [ordered]@{
    navy    = @{ master = 'sprites\agents\good_male_brown\navy_model_v2.png';                 H = 152; grab = $true; flex = $true; cell = @(480, 448); v2 = $true }   # tall muscular suit man
    polo    = @{ master = 'sprites\agents\good_male_white\polo_model_v2.png';                H = 112; grab = $false; v2 = $true; frames = @{ walk_front = 6; run_front = 6 } }   # short round polo man
    plum    = @{ master = 'sprites\agents\good_female_hijab\plum_model_v2.png';               H = 128; grab = $false; v2 = $true; frames = @{ walk_front = 6; walk_back = 6 } }   # plum suit, turban hijab
    cream   = @{ master = 'sprites\agents\good_female_nohijab\cream_model_v2.png';            H = 150; grab = $false; v2 = $true; frames = @{ walk_front = 6; walk_back = 6 } } # tall slim, black bob, mustard hoodie + jeans
    fighter = @{ master = 'sprites\agents\bad_male_brown\bad_male_brown_master_v2.png';      H = 130; grab = $false }   # street fighter, headband
    gangly  = @{ master = 'sprites\agents\bad_male_white\bad_male_white_master_v2.png';      H = 148; grab = $false }   # thin hunched
    sporty  = @{ master = 'sprites\agents\bad_female_hijab\bad_female_hijab_master_v3.png';  H = 118; grab = $true; cell = @(464, 352) }   # short sturdy sport-hijab woman
    curvy   = @{ master = 'sprites\agents\bad_female_nohijab\bad_female_nohijab_master_v1.png'; H = 138; grab = $false } # curvy curly hair
}

# Sheets: name, frames, grid rows. Every sheet starts with the neutral standing pose (used to calibrate its scale automatically).
function Get-EnemySheets($grab, $wRows = 3, $flex = $false) {
    $s = @(
        @{ name = 'a'; n = 16; rows = 4 },    # idle 8 + walk 8
        @{ name = 'b'; n = 16; rows = 4 },    # punch 8 + kick 8
        @{ name = 'c'; n = 16; rows = 4 },    # hurt 4 + knockdown 6 + get_up 6
        @{ name = 'd'; n = 16; rows = 4 }     # defeat 8 + (throw headset 8 | grab 8)
    )
    # grabbers: ONE sheet drawn with Zee inside it (so both are perfectly in sync): coil, lunge, clamp, hoist, overhead hold x3, wind-up x2, heave, release, recover
    if ($grab) { $s += @{ name = 'g'; n = 16; rows = 4; feet = $true } }
    # dedicated walk cycle: 12 frames = two identical half-steps with the legs swapped (a perfect loop). No standing frame, so scale = median frame height.
    $s += @{ name = 'w'; n = 12; rows = $wRows; median = $true }     # (wRows: how many rows the generated sheet actually has, 3 normally)
    if ($flex) { $s += @{ name = 'f'; n = 12; rows = 3 } }           # navy only: biceps-flex idle loop (frame 1 = neutral standing)
    return $s
}

# Game animations: name -> sheet, from, to (frame numbers in the strip), fps, loop; active/release = frame indexes INSIDE the animation (0-based)
function Get-EnemyAnims($grab, $hasW = $false, $hasF = $false) {
    $walk = if ($hasW) { @{ name = 'walk'; strip = 'w'; from = 0; to = 11; fps = 14; loop = $true } } else { @{ name = 'walk'; strip = 'a'; from = 8; to = 15; fps = 12; loop = $true } }
    $a = @(
        @{ name = 'idle';      strip = 'a'; from = 0;  to = 7;  fps = 8;  loop = $true },
        $walk,
        @{ name = 'punch';     strip = 'b'; from = 0;  to = 7;  fps = 22; loop = $false; active = @(3, 4) },
        @{ name = 'kick';      strip = 'b'; from = 8;  to = 15; fps = 22; loop = $false; active = @(3, 4) },
        @{ name = 'hurt';      strip = 'c'; from = 0;  to = 3;  fps = 14; loop = $false },
        @{ name = 'knockdown'; strip = 'c'; from = 4;  to = 9;  fps = 14; loop = $false },
        @{ name = 'get_up';    strip = 'c'; from = 10; to = 15; fps = 12; loop = $false },
        @{ name = 'defeat';    strip = 'd'; from = 0;  to = 7;  fps = 10; loop = $false }
    )
    if ($hasF) { $a += @{ name = 'flex'; strip = 'f'; from = 0; to = 11; fps = 9; loop = $false } }   # navy: shown now and then while standing (enemy.js)
    if ($grab) {
        # sheet g frame numbers (1-based): 1 neutral | 2 coil, 3 lunge, 4 CLAMP, 5-6 hoist, 7 overhead | 7-9 hold (ping-pong loop) | 10-11 wind-up, 12 heave, 13 RELEASE, 14-16 recover
        $a += @{ name = 'grab';  strip = 'g'; from = 1; to = 6;  fps = 12; loop = $false; active = @(2) }
        $a += @{ name = 'hold';  strip = 'g'; from = 6; to = 8;  fps = 9;  loop = $true; pingpong = $true }
        $a += @{ name = 'throw'; strip = 'g'; from = 9; to = 15; fps = 11; loop = $false; release = @(3) }
    } else {
        $a += @{ name = 'throw_headset'; strip = 'd'; from = 8; to = 15; fps = 18; loop = $false; release = @(3, 4) }
    }
    return $a
}



# ---- v2 set (navy first): one sheet per move, every move drawn from the same model sheet, plus front / back idle, walk and run ----
# Raw sheets: sprites/agents/raw/<id>_<name>.png. Frame 1 of every non-loop sheet = the side fighting idle (calibrates the scale);
# walk / run sheets have no standing frame, so they scale by their median frame height.
# $frames: optional per-enemy frame counts for sheets that were trimmed (e.g. @{ run_front = 6 })
function Get-EnemySheetsV2($grab, $flex, $frames) {
    $s = @(
        @{ name = 'idle';   n = 8;  rows = 2 },                  # fighting stance, breathing loop
        @{ name = 'walk';   n = 8;  rows = 2; median = $true },  # contact, down, passing, up  x2 legs
        @{ name = 'run';    n = 8;  rows = 2; median = $true },
        @{ name = 'punch';  n = 8;  rows = 2 },
        @{ name = 'kick';   n = 8;  rows = 2 },
        @{ name = 'hit';    n = 16; rows = 4 },                  # hurt 1-4, knockdown 5-8, get up 9-16
        @{ name = 'defeat'; n = 8;  rows = 2 }
    )
    if ($grab) { $s += @{ name = 'g'; n = 16; rows = 4; feet = $true; standH = 274 } }   # standH measured in game: grab Zee = real Zee, navy = his idle size (both within 2%)
    if (-not $grab) { $s += @{ name = 'throw'; n = 8; rows = 2 } }   # non-grabbers throw a call-centre headset instead
    if ($flex) { $s += @{ name = 'flex'; n = 12; rows = 3 } }
    $s += @{ name = 'idle_front'; n = 8; rows = 2 }
    $s += @{ name = 'idle_back';  n = 8; rows = 2 }
    $s += @{ name = 'walk_front'; n = 6; rows = 2; median = $true }
    $s += @{ name = 'walk_back';  n = 8; rows = 2; median = $true }
    $s += @{ name = 'run_front';  n = 8; rows = 2; median = $true }
    $s += @{ name = 'run_back';   n = 8; rows = 2; median = $true }
    if ($frames) { foreach ($x in $s) { if ($frames.ContainsKey($x.name)) { $x.n = $frames[$x.name] } } }
    return $s
}
function Get-EnemyAnimsV2($grab, $have, $counts) {
    $a = @(
        @{ name = 'idle';      strip = 'idle';   from = 0;  to = 7;  fps = 8;  loop = $true },
        @{ name = 'walk';      strip = 'walk';   from = 0;  to = 7;  fps = 10; loop = $true },   # (walk / run are driven by distance in enemy.js)
        @{ name = 'run';       strip = 'run';    from = 0;  to = 7;  fps = 14; loop = $true },
        @{ name = 'punch';     strip = 'punch';  from = 0;  to = 7;  fps = 22; loop = $false; active = @(3, 4) },
        @{ name = 'kick';      strip = 'kick';   from = 0;  to = 7;  fps = 22; loop = $false; active = @(3, 4) },
        @{ name = 'hurt';      strip = 'hit';    from = 0;  to = 3;  fps = 14; loop = $false },
        @{ name = 'knockdown'; strip = 'hit';    from = 4;  to = 7;  fps = 10; loop = $false },
        @{ name = 'get_up';    strip = 'hit';    from = 8;  to = 15; fps = 12; loop = $false },
        @{ name = 'defeat';    strip = 'defeat'; from = 0;  to = 7;  fps = 10; loop = $false },
        @{ name = 'flex';      strip = 'flex';   from = 0;  to = 11; fps = 9;  loop = $false }
    )
    foreach ($v in 'front', 'back') {
        $a += @{ name = "idle_$v"; strip = "idle_$v"; from = 0; to = 7; fps = 8; loop = $true }
        $a += @{ name = "walk_$v"; strip = "walk_$v"; from = 0; to = $(if ($v -eq 'front') { 5 } else { 7 }); fps = 10; loop = $true }
        $a += @{ name = "run_$v";  strip = "run_$v";  from = 0; to = 7; fps = 14; loop = $true }
    }
    if ($grab) {
        # sheet g frame numbers (1-based): 1 guard | 2 coil, 3 lunge, 4 CLAMP, 5-6 hoist, 7 overhead | 7-9 hold (ping-pong loop) | 10-11 wind-up, 12 heave, 13 RELEASE, 14-16 recover
        $a += @{ name = 'grab';  strip = 'g'; from = 1; to = 6;  fps = 12; loop = $false; active = @(2) }
        $a += @{ name = 'hold';  strip = 'g'; from = 6; to = 8;  fps = 9;  loop = $true; pingpong = $true }
        $a += @{ name = 'throw'; strip = 'g'; from = 9; to = 15; fps = 11; loop = $false; release = @(3) }
    } else {
        $a += @{ name = 'throw_headset'; strip = 'throw'; from = 0; to = 7; fps = 18; loop = $false; release = @(4) }   # frame 5 of the sheet: the headset leaves his hand
    }
    # loops use every frame their sheet has (some sheets are trimmed to 6 frames)
    foreach ($x in $a) { if ($x.loop -and -not $x.pingpong -and $counts.ContainsKey($x.strip)) { $x.to = $counts[$x.strip] - 1 } }
    return @($a | Where-Object { $have -contains $_.strip })
}
