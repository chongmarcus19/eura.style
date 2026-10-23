# Restore the pre-Mart landing page

The complete previous landing page is preserved in `index-before-marts.html`. All its original media and `support.js` remain in place. Open `/index-before-marts.html` to preview it.

To restore the old landing page:

```sh
cp index-before-marts.html index.html
git add index.html
git commit -m "Restore pre-Mart landing page"
git push origin main
```

GitHub Pages deploys pushes to main. This changes only the landing page; the new assets can remain for a later switch back. The pre-update tracked baseline was commit `7e59745`.
