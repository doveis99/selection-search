
// Localization helpers built on chrome.i18n. The messages are defined in
// _locales/<lang>/messages.json.
//
// Elements in the extension pages can be localized with data attributes:
//   data-i18n="key"              sets the text content
//   data-i18n-html="key"         sets the inner html (for messages containing markup)
//   data-i18n-placeholder="key"  sets the placeholder attribute
//   data-i18n-title="key"        sets the title attribute
//   data-i18n-value="key"        sets the value attribute (input buttons)


// Returns the localized message for the key. If the message is missing the
// key itself is returned, so missing translations are easy to spot.
function i18n(key, substitutions){
    var msg = chrome.i18n.getMessage(key, substitutions);
    return msg || key;
}


// Localizes all elements with i18n data attributes inside root (including root itself).
function applyI18n(root){

    root = root || document;

    var attributes = {
        'data-i18n-placeholder': 'placeholder',
        'data-i18n-title': 'title',
        'data-i18n-value': 'value',
    };

    function localize(el){
        if(el.hasAttribute('data-i18n'))
            el.textContent = i18n(el.getAttribute('data-i18n'));

        if(el.hasAttribute('data-i18n-html'))
            el.innerHTML = i18n(el.getAttribute('data-i18n-html'));

        for(var attr in attributes){
            if(el.hasAttribute(attr))
                el.setAttribute(attributes[attr], i18n(el.getAttribute(attr)));
        }
    }

    var selector = '[data-i18n],[data-i18n-html],[data-i18n-placeholder],[data-i18n-title],[data-i18n-value]';

    if(root.matches && root.matches(selector))
        localize(root);

    root.querySelectorAll(selector).forEach(localize);

    if(root === document)
        document.documentElement.lang = i18n('locale_code');
}
