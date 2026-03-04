// This script can be run inside puppeteer to extract exact UI selectors for the dropdowns
// once the settings popup is open.

(() => {
    const results = {};

    // Find all dropdown triggers
    const triggers = Array.from(document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], button[aria-haspopup="listbox"], div[class*="select"]'));

    triggers.forEach((t, i) => {
        let labelText = '';

        // Try preceding elements
        if (t.previousElementSibling) {
            labelText += t.previousElementSibling.textContent.trim() + ' ';
        }

        // Try parent elements
        if (t.parentElement) {
            // Strip out the text of the trigger itself to get the label
            const parentText = t.parentElement.cloneNode(true);
            const triggerInside = parentText.querySelector('[role="combobox"], [aria-haspopup="listbox"]');
            if (triggerInside) triggerInside.remove();
            labelText += parentText.textContent.trim();
        }

        // Try getting aria-label
        const ariaLabel = t.getAttribute('aria-label') || '';

        // Try getting specific inner text (currently selected value)
        const innerText = t.textContent.trim();

        results[`Trigger ${i}`] = {
            tagName: t.tagName,
            className: t.className,
            id: t.id,
            computedLabel: labelText.trim(),
            ariaLabel: ariaLabel,
            currentText: innerText
        };
    });

    console.log(JSON.stringify(results, null, 2));
    return results;
})();
