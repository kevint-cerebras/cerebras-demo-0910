const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function foodArt(kind: string, label = "", accent = "#3e624b"): string {
  const shadow =
    '<ellipse cx="100" cy="160" rx="49" ry="9" fill="#242921" opacity=".07"/>';
  let body = "";
  switch (kind) {
    case "avocado":
      body =
        '<g transform="rotate(-17 100 100)"><path d="M93 27C65 28 69 65 49 93c-30 45-4 70 37 71 49 2 63-29 39-68-17-26-6-66-32-69" fill="#335d33"/><path d="M92 35C72 36 75 69 57 98c-24 38-4 59 29 60 40 1 54-24 32-57-17-28-7-64-26-66" fill="#b5ce63"/><ellipse cx="88" cy="117" rx="28" ry="31" fill="#e9dc96"/><ellipse cx="88" cy="119" rx="23" ry="26" fill="#915832"/><path d="M82 100q-14 10-11 25" stroke="#bd8150" stroke-width="7" fill="none" stroke-linecap="round"/></g>';
      break;
    case "tomato":
      body =
        '<circle cx="74" cy="112" r="38" fill="#dc5239"/><circle cx="124" cy="102" r="43" fill="#ec6246"/><path d="m122 64-4 18-20-9 12 17-14 9 24-5 14 13-3-19 20-8-23 1z" fill="#4d713e"/><path d="m69 80-3 14-16-7 9 12-11 7 18-3 11 10-2-14 15-7-17 1z" fill="#496b3c"/><path d="M144 95q12 12 8 27" stroke="#f89476" fill="none" stroke-width="6" stroke-linecap="round"/>';
      break;
    case "lime":
    case "lemon":
      body = `<g transform="rotate(-18 100 100)"><ellipse cx="78" cy="99" rx="36" ry="43" fill="${kind === "lime" ? "#83a83e" : "#edc74e"}"/><circle cx="125" cy="127" r="34" fill="${kind === "lime" ? "#668637" : "#d8b03c"}"/><circle cx="125" cy="127" r="29" fill="#f5f0c5"/><circle cx="125" cy="127" r="25" fill="${kind === "lime" ? "#c1d483" : "#ebd87f"}"/><path d="M125 102v50m-25-25h50m-43-18 36 36m0-36-36 36" stroke="#f5f0c5" stroke-width="3"/></g>`;
      break;
    case "tortilla":
      body =
        '<g fill="#e6c991" stroke="#cfae72" stroke-width="1.5"><ellipse cx="100" cy="134" rx="64" ry="25"/><ellipse cx="100" cy="125" rx="64" ry="25"/><ellipse cx="100" cy="116" rx="64" ry="25"/><ellipse cx="100" cy="106" rx="64" ry="25"/></g><g fill="#bb945d" opacity=".5"><ellipse cx="72" cy="104" rx="5" ry="2"/><ellipse cx="110" cy="95" rx="7" ry="2"/><ellipse cx="132" cy="110" rx="4" ry="2"/><ellipse cx="93" cy="118" rx="5" ry="2"/><ellipse cx="54" cy="112" rx="3" ry="2"/></g>';
      break;
    case "onion":
      body =
        '<path d="M101 46c-5 25-55 34-55 69 0 29 22 46 54 46s56-17 56-46c0-35-46-44-55-69" fill="#a45f86"/><path d="M98 54q-49 69-5 102M103 54q40 65 8 101M101 54q-6 77 0 104" stroke="#ca8bab" fill="none" stroke-width="3"/><path d="m98 48-5-24m10 24 5-29" stroke="#89764c" stroke-width="4"/>';
      break;
    case "herb":
      body =
        '<g stroke="#64884c" stroke-width="5"><path d="m89 163 12-93m-12 85-30-61m30 49 48-55m-42 38-16-72"/></g><g fill="#527c40"><ellipse cx="57" cy="89" rx="25" ry="33" transform="rotate(-35 57 89)"/><ellipse cx="78" cy="64" rx="25" ry="33" transform="rotate(-15 78 64)"/><ellipse cx="112" cy="66" rx="23" ry="35" transform="rotate(24 112 66)"/><ellipse cx="143" cy="83" rx="25" ry="34" transform="rotate(40 143 83)"/></g><g fill="#78a255"><ellipse cx="100" cy="101" rx="25" ry="37" transform="rotate(10 100 101)"/></g><path d="m85 164 21 1" stroke="#baa57e" stroke-width="7"/>';
      break;
    case "banana":
      body =
        '<path d="M47 65c-8 67 43 102 99 59-48 13-76-13-82-63z" fill="#e6bf42"/><path d="M59 45c-8 68 36 108 95 72-50 8-73-23-78-73z" fill="#f0cf59"/><path d="m60 45 1-12 13 1 3 12m76 72 10-4" stroke="#81714b" stroke-width="5" fill="none"/>';
      break;
    case "berries":
      body =
        '<g fill="#52618b" stroke="#435077" stroke-width="2"><circle cx="67" cy="112" r="21"/><circle cx="102" cy="132" r="22"/><circle cx="134" cy="105" r="23"/><circle cx="98" cy="88" r="22"/><circle cx="66" cy="145" r="19"/><circle cx="137" cy="144" r="18"/></g><g fill="#929dbc"><path d="m96 73 4 6 8-2-4 8 5 4-9-1-5 5-1-8-6-5 8-1z"/><path d="m134 92 3 5 7-1-4 6 4 4-6-1-4 4-1-6-5-4 6-1z"/></g><ellipse cx="104" cy="56" rx="9" ry="22" fill="#65854f" transform="rotate(35 104 56)"/>';
      break;
    case "pepper":
      body =
        '<path d="M97 78c-40-32-60 5-52 39 8 44 23 47 49 31 26 19 44 7 54-27 15-45-16-71-44-43z" fill="#de6940"/><path d="M98 79c-22 7-23 48-12 72m18-70c21 15 20 50 9 68" stroke="#ee8652" stroke-width="5" fill="none"/><path d="M98 81c-8-16-1-35 10-42" stroke="#537b3c" stroke-width="10" fill="none" stroke-linecap="round"/>';
      break;
    case "mushroom":
      body =
        '<path d="m66 114-6 42q18 12 36 0l-8-42m39-18-7 45q13 11 28 0l-4-45" fill="#dfd2be"/><path d="M33 112c0-68 90-68 90 0q-44 26-90 0" fill="#9b7a5e"/><path d="M102 95c0-52 69-53 70 0q-36 23-70 0" fill="#ab8c6e"/><path d="M50 87q10-28 38-22" stroke="#bea083" stroke-width="6" fill="none" stroke-linecap="round"/>';
      break;
    case "garlic":
      body =
        '<path d="M99 56C88 90 48 87 48 122c0 49 104 49 104 0 0-37-39-33-47-66z" fill="#eee5d5" stroke="#cec4ad" stroke-width="2"/><path d="M99 65q-38 62-10 92m15-92q33 66 8 93m-11-94v95" stroke="#d8ceba" fill="none" stroke-width="2"/><path d="m101 59 5-30" stroke="#c9bd9d" stroke-width="9"/>';
      break;
    case "cucumber":
      body =
        '<rect x="77" y="26" width="49" height="136" rx="24" fill="#4d7543" transform="rotate(28 100 100)"/><path d="m122 46-50 94m60-90-51 98" stroke="#73955e" stroke-width="3"/><ellipse cx="130" cy="145" rx="29" ry="20" fill="#b7ce88" stroke="#60834b" stroke-width="5"/><ellipse cx="130" cy="145" rx="14" ry="10" fill="#e2e7b8"/>';
      break;
    case "potato":
      body =
        '<ellipse cx="77" cy="106" rx="31" ry="56" transform="rotate(35 77 106)" fill="#b87748"/><ellipse cx="123" cy="118" rx="26" ry="46" transform="rotate(44 123 118)" fill="#cf915b"/><g fill="#935d39"><circle cx="81" cy="77" r="2"/><circle cx="61" cy="114" r="2"/><circle cx="118" cy="112" r="2"/><circle cx="103" cy="138" r="2"/></g>';
      break;
    case "bread":
      body =
        '<path d="M46 90c0-67 110-67 110 0v63H46z" fill="#b78349"/><path d="M54 93c0-59 94-59 94 0v52H54z" fill="#e7c696"/><path d="M65 91c0-42 72-42 72 0v44H65z" fill="#eed7b0"/><g fill="#c6a374"><ellipse cx="88" cy="80" rx="5" ry="3"/><ellipse cx="119" cy="91" rx="4" ry="3"/><ellipse cx="85" cy="114" rx="3" ry="4"/><ellipse cx="114" cy="121" rx="5" ry="3"/></g>';
      break;
    case "eggs":
      body =
        '<path d="m33 116 18 40h105l18-40z" fill="#b5a585"/><ellipse cx="103" cy="116" rx="70" ry="24" fill="#d6c9ac"/><g fill="#f3e3c7" stroke="#e1d0b0" stroke-width="1"><ellipse cx="61" cy="101" rx="16" ry="24"/><ellipse cx="101" cy="101" rx="16" ry="24"/><ellipse cx="142" cy="101" rx="16" ry="24"/><ellipse cx="80" cy="123" rx="16" ry="24"/><ellipse cx="122" cy="123" rx="16" ry="24"/></g>';
      break;
    case "tray":
      body = `<rect x="31" y="60" width="138" height="92" rx="17" fill="#f7f3e9" stroke="#d6c9b7" stroke-width="3"/><path d="M48 88q24-29 45 0v41q-24 12-45-2zm56 0q24-29 45 0v41q-24 12-45-2z" fill="${label.toLowerCase().includes("salmon") ? "#ed9a76" : "#e8b7a0"}"/><path d="m55 85 30 39m-34-23 27 29m35-45 27 37" stroke="#f7d9c4" stroke-width="3"/><rect x="65" y="105" width="74" height="32" fill="#f8f5ea"/><text x="102" y="124" text-anchor="middle" fill="${accent}" font-size="9" font-family="sans-serif" font-weight="700">FRESH CUTS</text>`;
      break;
    default: {
      const short = esc(
        label
          .replace(
            /Organic |Unsweetened |Gluten-free |Extra virgin |Long grain /g,
            "",
          )
          .split(" ")
          .slice(0, 3)
          .join(" "),
      );
      if (kind === "carton")
        body = `<path d="m65 55 13-27h45l14 27v108H65z" fill="#f3eee1"/><path d="m65 55 13-27v27h59v108H65z" fill="#e4dcc8"/><path d="M78 28h45v27H78z" fill="${accent}"/><rect x="65" y="75" width="72" height="68" fill="#faf7ec"/><circle cx="128" cy="50" r="7" fill="#fffdf4"/>`;
      else if (kind === "bottle")
        body = `<rect x="84" y="30" width="34" height="40" rx="6" fill="#5c6540"/><rect x="80" y="22" width="42" height="20" rx="3" fill="#303d2b"/><path d="M84 61h34l14 22v76H70V83z" fill="#657148"/><rect x="70" y="93" width="62" height="53" fill="#f4edcf"/>`;
      else if (kind === "jar")
        body = `<rect x="64" y="50" width="74" height="110" rx="13" fill="${label.includes("butter") ? "#bd9154" : "#b75b3e"}"/><rect x="61" y="42" width="80" height="19" rx="5" fill="${accent}"/><rect x="64" y="78" width="74" height="60" fill="#f6edda"/>`;
      else if (kind === "tub")
        body = `<path d="m50 69 13 90h78l12-90z" fill="#f6f1e5"/><ellipse cx="102" cy="69" rx="52" ry="14" fill="${accent}"/><path d="m55 94 8 48h78l7-48z" fill="#e1e7d9"/>`;
      else if (kind === "can")
        body = `<rect x="64" y="44" width="74" height="116" rx="9" fill="#c4c9c2"/><rect x="64" y="58" width="74" height="87" fill="#f3eddb"/><ellipse cx="101" cy="46" rx="37" ry="9" fill="#dce0d8"/><ellipse cx="101" cy="46" rx="29" ry="5" fill="#c5cbc1"/><rect x="64" y="133" width="74" height="11" fill="${accent}"/>`;
      else
        body = `<path d="m64 35 76 0-5 19 11 106H55L67 54z" fill="${kind === "pasta" ? "#dcb763" : "#e1d4b7"}"/><path d="M64 35h76v12H64z" fill="${accent}"/><path d="M60 79h82v64H60z" fill="#f5efdf"/><path d="m55 153 91 0v7H55z" fill="${accent}"/>`;
      body += `<text x="101" y="101" text-anchor="middle" fill="${accent}" font-size="8" letter-spacing="2" font-family="sans-serif">EVERYDAY</text><text x="101" y="117" text-anchor="middle" fill="${accent}" font-size="8" font-weight="700" font-family="sans-serif">${short}</text><path d="m94 126 7-4 7 4-7 5z" fill="${accent}" opacity=".65"/>`;
    }
  }
  // Each illustration is local vector artwork; no product-image network requests.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 190" fill="none" aria-hidden="true">${shadow}${body}</svg>`;
}
