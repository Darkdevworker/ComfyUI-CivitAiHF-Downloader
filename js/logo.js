/**
 * logo.js — the Civitai "C" mark used for this extension's icon.
 *
 * ComfyUI's `registerSidebarTab()` only accepts icon *fonts* (pi/mdi/fa), so we
 * ship assets/civitai-icon.png as a data URI and paint it over the glyph with
 * CSS (see .cvt-sidebar-logo in civitai.css). Embedding it keeps the icon
 * working no matter how the extension folder is named or mounted.
 *
 * Source files: assets/civitai-icon.png and assets/downloads-icon.png
 * (both 28x28, transparent).
 */

export const CIVITAI_LOGO_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAYAAAByDd+UAAAFMUlEQVR4AZRVa2wUVRg9M7ut3S2lW1woLaT8aKWUChoeCSEmxvADDSiWGBojIQUpP4gFIkQxQQFjgIg8BAIYtKIJGpTyiFg1Rg3GB4qCFrFKAhgwYLWPbbvvx1znfN277W5bWiZ77v3u+c73nbl3ZloTd3o9etM9an3XWs8LnZthx3daPmzDvKrmuz3PdSwsqMw9r0zjNcMwX2JMjrnhGg9taO+CTZ0Ti7YaTmcDTLM81dyOyTkmFL5DzXB2fFvD/OU3pxdMdu+GYe6Hw1GbMsoIDHfWPGqoZU1GOm05sKG9Kz4n05t7RMVRi7gqVJEECFZb126AYEyOEI2tZQ2f72DH3M+QR+MpyTpjBeLbVUz1Hh+7+yNIfH8ejm9OChjD5pjSkBp/4kVHsfdT9tK8nlOGeVVXJnrWtJ9GSB2D6ZgugqilkIT64zLMxrdgNjUi2NIuYEyOOa2TmcXsYfdiz3z70ZAixLBg/pUSR/HIIwjF5iEaM/pCtf5joPGUEfn8AzEJdyfgLhwlYExz5syTBw3RZtRLT2U0cEMpQwaZUF1tUGfPINJQj/CNS5LOyXOgamEx3jv0uIAxzZkUY1vLGqmNKtL9IDska7WFLWWLBLYZn1Ok+UemBA/PLcCu7Y9gz95azJ1bIaivr8OOzbPlJpC8WMNahNshveyeyZRMKUNZ6aHLDyvYKauyMgPbtj6Aba/WoGbpg/B6RwjPIcflFG7jxmocODgf1JKXWrsH40ykGapgDIQWWbFOlJV68NSSOSifVCx0a6sfh98+I2BMkjnezJSpRWANORUMcZJ+qiNiycIe0gztdb+fK9eFEbk5wv9y4Ro2bngXa9ccFayqO4TXd54Sc95E+7//iU4PfW9ec4MamrEurUnNV6+04ONTTfB3x4VrONqMlzd/Jua8iXM/+TAiz4mBaqXAHtIMVcA+UiJ5HHZ+0J82pSDPbYFgnKUCnAS6nyySQ8ow0RZMUr1TNtJ3WXlvCeYtmIqiQlOwfMX92LG7Gjv31uCNw6sxc4YHAf2XJzjEZ9Frkx6FAiH4A2Eh+XLs2LVCDDZteRKM+bIsfGKWfCajxowWXeaQ6OipJ5/aIRfKHwUB++700Vw4dx379xwHXxhq+CnQgEaMyTHHl+di0y0uoWu5kH4MkkgzTHKA20DMyIXbEUJbiw/bX2nE+nU9b6T+FKhlTCPmNqx7H381X5ca5ohMM3IDGlqqEPGKasSLZkkDGn/71VWw6eLqLfIZHD92FrXL9mDrpuNgjhoiml+B0ORlsFxj2b8feg19kbsQTkDDMkYjOm4BIpWLEXePSxlf+PoS1q+ux7N1h/HdJz9AhXySM1yeHu09S8Ba3Ufm9lCWdhbDjtOl1533eZ9WgciXOqHnhKsS0cnPIDqhCmxKniah1lsMhWPOX7YO1ArZZ1CJxK9Qqqb7ROll0mLIoPPN4p8DF6fNgT+0kiKV/A+v58jImegev0qOmcYEj5wcc+yhtTLTyO4VGOudHWia9gXzRMqQC8L/24wD5visOSoS2wcr8Tc5woQFIycbIe9jiIx5qAfe+cKZdo4agV3DWnN87iL2wkfFaR94P0MWdZ+oaAv+Pr2OR8FiFY75VNj+ZGwY4TC4o2j2FGiuZ475qGUNa/URsl9fDGioBTyKYGnR86alVhhOM/V8aao1nJmjxlHu3sQacoPhtoZSZB+J/88ZH5plrkWmAyuNbEfqmAHDRy57Qv5SangyGOIa2jDZgM34TAIlheUwjH2EY5K7jBzf8qRsyOl/AAAA///V26VSAAAABklEQVQDAM4r3gQMPnfSAAAAAElFTkSuQmCC";

export const CIVITAI_LOGO_FILENAME = "civitai-icon.png";

/** Green download arrow used by the Downloads tab. */
export const DOWNLOADS_LOGO_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAYAAAByDd+UAAADeElEQVR4nLVWTWsbVxQ99z7JHke2FTtqwIzTxDQ4IaG0IJMPXLDjRXGg0EWJF6V0E7JI/0DpSoQuuunK0J/QjVzopnTT0kYUDImsT4+dWoVkYboo3tSJLRkp804XmrElW6mtVjkwIEb3nnPvefe9N8BJkYICkPnK/PhgfvBZLBd7Nrcx54IQEHJSGj1p4MzsjALgZnXzWvVU9UItVruwWd28BgG74TlxYGY2QwAQCqXRfIwYAYCZhzO97zCED58UCgRiYLpN78LSoAsVVYGAIPbsng8cdN9TwZC0IQ2fIAQCR51IazE9FQxJHTom7LDOum0tpqeCIXz4+79f6xqGXVhaG1pqxCjwmi09NDQvW4v5f4KHTpBOHXYcmmNOns6CTT4GjbTZ1tqhT785NMiEedqS11G0s6CAJCNe2uuDwCJ9MB0GZp/IwhIA7szeIQgDgV1eXh5ghf3BkXdEtF0wsGNuY86NF+Mr1y9fX00Wk+9hAX4GmQgANHiwD6M2agBg6eFSFAI/uZqcvj14e/X0zunsjcINFww4Xym41LRku749WT1TfWeXu5Oeej9dLFz8RG/pHlLQfvRHpWkB6qZOpKByS/bO589/7NH7edtuv7VzZuftqlQvQUAsHTeYhKaZNmdzZ7+KrEeIHPzoWpRu2f1SoZgoTnxg1gzNmuFkfvJDAwO35D6IeM3YyJMI3Zz7dTqdNuH6Hw9CFAq34N7rK/W9RA5WK8rRwug30+XpBeMZq55yanXqo5H8yKL5wxA52P5yvz+Rn/hMoUesPB6/IgIAVwtX33fKzhbKoJSEAysDf+ERrGaV8Vz8bxRBlEGn7GxdKV6ZF8h+bvdgM/Hmys3Lw6XhdayDeAwiGzyPYPEEHCoPeVOPpy61FvrfERDc/+3+yGh59EetKJFFA1k0tKIcLg3/cHf57mhvxEIE+5CkJEqJRf1dqRvKRCmxSFJaY3qHFBQpqEIxVhj7/Fzx3BcK3X/fW7EQhLSRp6DdTmPn4DQM3vgXolpg30DL5XgYWyAWjv7/SlLpdhsdAtH5xmpnTUHxAHY8Pz5TO1X7VKqiFHZnGYUSEztUG/r26btPfwluENtJUECAoMbz8c3niedj2EX3HyEWQAwY3Br880XyxZsCCVeZANr2TfgFbR11vqvv1O+hBiHY7bj7AqGjzvcBpwRlAAD+ATvLjIfp6i5RAAAAAElFTkSuQmCC";

/**
 * Which tab gets an image instead of an emoji, keyed by tab id.
 * Add an entry here (and a PNG under assets/) to swap another tab.
 */
export const TAB_LOGOS = {
  civitai: CIVITAI_LOGO_PNG,
  downloads: DOWNLOADS_LOGO_PNG,
};

/**
 * Paint the logo onto our sidebar button.
 *
 * The frontend stamps `data-testid="<tabId>-tab-button"` on the button, which
 * is what civitai.css targets; for older frontends we also tag the button with
 * `.cvt-sidebar-tab` here (retried, because the sidebar mounts asynchronously).
 */
export function installSidebarLogo(tabId, needle) {
  tabId = tabId || "civitai-hf";
  needle = (needle || "Civitai").toLowerCase();

  // expose the image to CSS
  try {
    document.documentElement.style.setProperty(
      "--cvt-sidebar-logo", "url(" + CIVITAI_LOGO_PNG + ")"
    );
  } catch (e) { /* ignore */ }

  var attempts = 0;
  function tag() {
    var found = 0;
    var buttons = document.querySelectorAll(
      '[data-testid="' + tabId + '-tab-button"], .side-bar-button, [class*="side-bar-button"]'
    );
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var label = (b.getAttribute("aria-label") || b.textContent || "").toLowerCase();
      var isOurs =
        b.getAttribute("data-testid") === tabId + "-tab-button" ||
        label.indexOf(needle) >= 0;
      if (isOurs && !b.classList.contains("cvt-sidebar-tab")) {
        b.classList.add("cvt-sidebar-tab");
      }
      if (b.classList.contains("cvt-sidebar-tab")) found++;
    }
    if (!found && attempts++ < 40) setTimeout(tag, 250);
  }
  tag();
}

/** Small <img> of a tab logo, for use inside the panel. */
export function makeLogo(size, alt, name) {
  var img = document.createElement("img");
  img.src = (name && TAB_LOGOS[name]) || CIVITAI_LOGO_PNG;
  img.alt = alt || "Civitai";
  img.className = "cvt-logo";
  img.style.width = (size || 16) + "px";
  img.style.height = (size || 16) + "px";
  img.style.display = "block";
  img.style.flexShrink = "0";
  return img;
}
