// Per-table column specs used by the saveCache apply loop.
//
// Each spec describes how to materialize a row uploaded from the device into
// the real legacy table. Format:
//
//   {
//     pk:      'PK_Site',                            // primary-key column name
//     pkType:  'UniqueIdentifier' | 'NVarChar(20)',  // mssql sql-type fragment
//     columns: [
//       { name: 'PK_Site',         t: 'UniqueIdentifier'        },
//       { name: 'FK_Species_Site', t: 'NVarChar(20)'            },
//       { name: 'SiteID',          t: 'NVarChar(100)', n: true  }, // n=nullable
//       ...
//     ]
//   }
//
// The list excludes the SyncKey + SyncState columns: those are owned by the
// server and stamped by the apply loop directly (SyncState=4, SyncKey=epoch ms).
//
// Tables omitted here are intentionally rejected by saveCache for now — admin
// tables like TypeList/SubTypeList/Species/Report should not be written from
// field devices in this contract.

const SPECS={

    Site: {
        pk: 'PK_Site',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_Site',t: 'UniqueIdentifier'},
            {name: 'FK_Species_Site',t: 'NVarChar(20)'},
            {name: 'FK_Species_SiteStatus',t: 'NVarChar(20)'},
            {name: 'FK_Species_ElevUnits',t: 'NVarChar(20)'},
            {name: 'SiteID',t: 'NVarChar(100)',n: true},
            {name: 'Alias',t: 'NVarChar(100)',n: true},
            {name: 'Notes',t: 'NVarChar(MAX)',n: true},
            {name: 'Slope',t: 'Int',n: true},
            {name: 'Aspect',t: 'Int',n: true},
            {name: 'Elevation',t: 'Int',n: true},
            {name: 'DateEstablished',t: 'DateTime',n: true}
        ]
    },

    SiteClass: {
        pk: 'PK_SiteClass',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_SiteClass',t: 'UniqueIdentifier'},
            {name: 'FK_Species_SiteClass',t: 'NVarChar(20)',n: true},
            {name: 'CK_ParentClass',t: 'UniqueIdentifier',n: true},
            {name: 'ClassID',t: 'NVarChar(20)',n: true},
            {name: 'ClassName',t: 'NVarChar(100)',n: true},
            {name: 'Description',t: 'NVarChar(4000)',n: true}
        ]
    },

    SiteClassLink: {
        pk: 'PK_SiteClassLink',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_SiteClassLink',t: 'UniqueIdentifier'},
            {name: 'FK_Site',t: 'UniqueIdentifier'},
            {name: 'FK_SiteClass',t: 'UniqueIdentifier'}
        ]
    },

    Locator: {
        pk: 'PK_Locator',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_Locator',t: 'UniqueIdentifier'},
            {name: 'FK_Species_Locator',t: 'NVarChar(20)'},
            {name: 'FK_Site',t: 'UniqueIdentifier'},
            {name: 'LocatorID',t: 'NVarChar(255)',n: true},
            {name: 'Description',t: 'NVarChar(4000)',n: true},
            {name: 'Date',t: 'DateTime',n: true},
            {name: 'IsPrimary',t: 'Bit'},
            {name: 'DDLat',t: 'Float',n: true},
            {name: 'DDLong',t: 'Float',n: true},
            {name: 'LocatorElevation',t: 'Int',n: true}
        ]
    },

    SitePhoto: {
        pk: 'PK_Site',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_Site',t: 'UniqueIdentifier'},
            {name: 'PK_PhotoDoc',t: 'UniqueIdentifier',n: true}
        ]
    },

    Protocol: {
        pk: 'PK_Protocol',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_Protocol',t: 'UniqueIdentifier'},
            {name: 'FK_Type_Protocol',t: 'UniqueIdentifier',n: true},
            {name: 'Bailiwick',t: 'NVarChar(50)',n: true},
            {name: 'ProtocolName',t: 'NVarChar(200)',n: true},
            {name: 'Date',t: 'DateTime'},
            {name: 'DateEnd',t: 'DateTime',n: true},
            {name: 'Notes',t: 'NVarChar(4000)',n: true}
        ]
    },

    EventGroup: {
        pk: 'PK_EventGroup',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_EventGroup',t: 'UniqueIdentifier'},
            {name: 'FK_Type_EventGroup',t: 'UniqueIdentifier'},
            {name: 'FK_Protocol',t: 'UniqueIdentifier'},
            {name: 'Attributes',t: 'NVarChar(MAX)',n: true},
            {name: 'GroupName',t: 'NVarChar(200)',n: true},
            {name: 'DisplayOrder',t: 'Int',n: true},
            {name: 'DefaultFormID',t: 'UniqueIdentifier',n: true}
        ]
    },

    Event: {
        pk: 'PK_Event',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_Event',t: 'UniqueIdentifier'},
            {name: 'FK_Type_Event',t: 'UniqueIdentifier'},
            {name: 'FK_Site',t: 'UniqueIdentifier',n: true},
            {name: 'FK_SiteClass',t: 'UniqueIdentifier',n: true},
            {name: 'FK_EventGroup',t: 'UniqueIdentifier'},
            {name: 'EventName',t: 'NVarChar(50)',n: true},
            {name: 'Attributes',t: 'NVarChar(MAX)',n: true},
            {name: 'PageNumber',t: 'Int',n: true},
            {name: 'EntryOrder',t: 'Int',n: true},
            {name: 'DefaultEventID',t: 'UniqueIdentifier',n: true}
        ]
    },

    Sample: {
        pk: 'PK_Sample',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_Sample',t: 'UniqueIdentifier'},
            {name: 'FK_Event',t: 'UniqueIdentifier'},
            {name: 'FK_Species',t: 'NVarChar(20)',n: true},
            {name: 'Transect',t: 'Int'},
            {name: 'SampleNumber',t: 'Int'},
            {name: 'Element',t: 'NVarChar(10)',n: true},
            {name: 'SubElement',t: 'NVarChar(10)',n: true},
            {name: 'FieldSymbol',t: 'NVarChar(20)',n: true},
            {name: 'SpeciesQualifier',t: 'NVarChar(20)',n: true},
            {name: 'FieldQualifier',t: 'NVarChar(20)',n: true},
            {name: 'cParameter',t: 'NVarChar(20)',n: true},
            {name: 'cParameter2',t: 'NVarChar(20)',n: true},
            {name: 'cParameter3',t: 'NVarChar(20)',n: true},
            {name: 'nValue',t: 'Float',n: true},
            {name: 'nValue2',t: 'Float',n: true},
            {name: 'nValue3',t: 'Float',n: true},
            {name: 'cValue',t: 'NVarChar(100)',n: true},
            {name: 'cValue2',t: 'NVarChar(100)',n: true},
            {name: 'cValue3',t: 'NVarChar(100)',n: true}
        ]
    },

    SampleDatum: {
        pk: 'PK_SampleDatum',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_SampleDatum',t: 'UniqueIdentifier'},
            {name: 'FK_Sample',t: 'UniqueIdentifier'},
            {name: 'ValueName',t: 'NVarChar(50)',n: true},
            {name: 'NumValue',t: 'Float',n: true},
            {name: 'NumValue2',t: 'Float',n: true},
            {name: 'CharValue',t: 'NVarChar(100)',n: true},
            {name: 'FK_PhotoDoc',t: 'UniqueIdentifier',n: true}
        ]
    },

    PhotoDoc: {
        pk: 'PK_PhotoDoc',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_PhotoDoc',t: 'UniqueIdentifier'},
            {name: 'FK_Site',t: 'UniqueIdentifier',n: true},
            {name: 'FK_Species_PhotoDoc',t: 'NVarChar(20)',n: true},
            {name: 'FK_Locator',t: 'UniqueIdentifier',n: true},
            {name: 'SeriesID',t: 'NVarChar(255)',n: true},
            {name: 'Description',t: 'NVarChar(4000)',n: true},
            {name: 'PathUrl',t: 'NVarChar(2000)',n: true},
            {name: 'ContentID',t: 'NVarChar(255)',n: true},
            {name: 'Notes',t: 'NVarChar(MAX)',n: true},
            // Content (varbinary(max)) intentionally omitted — image bytes go via
            // a separate upload flow, not JSON.
            {name: 'Date',t: 'DateTime',n: true}
        ]
    },

    Inquiry: {
        pk: 'PK_Inquiry',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_Inquiry',t: 'UniqueIdentifier'},
            {name: 'FK_Event',t: 'UniqueIdentifier'},
            {name: 'FK_SpList',t: 'UniqueIdentifier',n: true},
            {name: 'CK_Parent',t: 'UniqueIdentifier',n: true},
            {name: 'InquiryID',t: 'NVarChar(20)'},
            {name: 'Attributes',t: 'NVarChar(MAX)',n: true},
            {name: 'InquiryText',t: 'NVarChar(4000)'},
            {name: 'Comment',t: 'NVarChar(4000)',n: true},
            {name: 'Tip',t: 'NVarChar(MAX)',n: true}
        ]
    },

    InquiryDatum: {
        pk: 'PK_InquiryDatum',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_InquiryDatum',t: 'UniqueIdentifier'},
            {name: 'FK_Inquiry',t: 'UniqueIdentifier'},
            {name: 'FK_PhotoDoc',t: 'UniqueIdentifier',n: true},
            {name: 'FK_Species',t: 'NVarChar(20)',n: true},
            {name: 'CharValue',t: 'NVarChar(4000)',n: true},
            {name: 'NumValue',t: 'Float',n: true},
            {name: 'NumValue2',t: 'Float',n: true}
        ]
    },

    Contact: {
        pk: 'PK_Contact',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_Contact',t: 'UniqueIdentifier'},
            {name: 'FK_Species_Contact',t: 'NVarChar(20)'},
            {name: 'Active',t: 'Bit'},
            {name: 'ContactID',t: 'NVarChar(20)',n: true},
            {name: 'FamilyName',t: 'NVarChar(50)',n: true},
            {name: 'GivenName',t: 'NVarChar(50)',n: true},
            {name: 'OtherName',t: 'NVarChar(50)',n: true},
            {name: 'Notes',t: 'NVarChar(4000)',n: true},
            {name: 'Organization',t: 'NVarChar(50)',n: true},
            {name: 'PositionTitle',t: 'NVarChar(50)',n: true}
        ]
    },

    ContactLink: {
        pk: 'PK_ContactLink',
        pkType: 'UniqueIdentifier',
        columns: [
            {name: 'PK_ContactLink',t: 'UniqueIdentifier'},
            {name: 'FK_Contact',t: 'UniqueIdentifier'},
            {name: 'FK_SiteClass',t: 'UniqueIdentifier',n: true},
            {name: 'FK_Protocol',t: 'UniqueIdentifier',n: true},
            {name: 'FK_Site',t: 'UniqueIdentifier',n: true},
            {name: 'FK_Species_ContactRole',t: 'NVarChar(20)'},
            {name: 'DateStart',t: 'DateTime',n: true},
            {name: 'DateEnd',t: 'DateTime',n: true}
        ]
    }
};

// FK-safe order for applying a saveCache batch. Parents first, children last.
// Within a single table we further sort by op (delete last to avoid pulling
// rows other ops still need).
const APPLY_ORDER=[
    // create/update parents first
    'Site',
    'SiteClass',
    'SiteClassLink',
    'Locator',
    'Protocol',
    'EventGroup',
    'Event',
    'PhotoDoc',
    'SitePhoto',
    'Sample',
    'SampleDatum',
    'Contact',
    'ContactLink',
    'Inquiry',
    'InquiryDatum'
];

module.exports={SPECS,APPLY_ORDER};
