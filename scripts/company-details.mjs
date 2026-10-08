// Confirmed public company details. Unconfirmed office addresses stay unpublished.
export const companyDetails = {
  email: 'sales@entity-1.com',
  heroHeading: 'Rare cars.\nPrivate access.',
  heroDescription: 'A private brokerage for sourcing and brokering high-performance cars beyond the open market.',
  headline: 'Different backgrounds.\nOne connected entity.',
  introduction: 'ENTITY-1 is a private entity brokerage firm specialising in high-performance, off-market automobiles. We bring together experience in sales, technology and commodities to connect exceptional cars with the people looking for them.',
  about: 'ENTITY-1 was formed around a shared network. Our team comes from different backgrounds in sales, technology and commodities, bringing distinct experience and relationships to one private brokerage.\n\nWe combine that knowledge to source and broker high-performance, off-market cars. For owners and collectors, that means a personal introduction, a wider network and a direct conversation about what comes next.\n\nOur network spans Monaco, Munich, Dubai, Miami, London and beyond. Wherever the search begins, our approach remains personal and discreet.',
  networkCities: 'Monaco\nMunich\nDubai\nMiami\nLondon',
  offices: [],
  members: [
    {name: 'Ahnaf Adib', position: 'Chief Executive Officer'},
    {name: 'Idrees', position: 'Chief Technology Officer'},
    {name: 'Chris', position: 'Executive · India'},
    {name: 'Bhav', position: 'Executive'},
    {name: 'Jasper', position: 'Executive'}
  ],
  partners: [
    {name: 'Zephyra Motors', mark: 'ZEPHYRA MOTORS', url: ''},
    {name: 'Octonox Group', mark: 'OCTONOX GROUP', url: ''},
    {name: 'RM Sotheby’s', mark: 'RM Sotheby’s', url: 'https://rmsothebys.com/'}
  ]
};

export function applyCompanyDetails(content) {
  const next = structuredClone(content);
  const existing = next.settings.partners || [];
  Object.assign(next.settings, structuredClone(companyDetails));
  next.settings.partners = companyDetails.partners.map(partner => {
    const previous = existing.find(item => item.name.toLowerCase() === partner.name.toLowerCase());
    return {...partner, ...(previous?.image ? {image: previous.image} : {}), url: previous?.url || partner.url};
  });
  return next;
}
