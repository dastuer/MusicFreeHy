/** 与 MusicFree 移动端 / MusicFreeDesktop 保持一致的核心数据类型 */

declare namespace ICommon {
    export type SupportMediaType = "music" | "album" | "artist" | "sheet" | "lyric";

    export type SupportMediaItemBase = {
        music: IMusic.IMusicItemBase;
        album: IAlbum.IAlbumItemBase;
        artist: IArtist.IArtistItemBase;
        sheet: IMusic.IMusicSheetItemBase;
        lyric: ILyric.ILyricItem;
    };

    export type IUnique = {
        id: string;
        [k: string | symbol]: any;
    };

    export type IMediaBase = {
        id: string;
        platform: string;
        [k: string]: any;
    };

    export type PaginationResponse<T> = {
        isEnd?: boolean;
        data?: T[];
    };
}

declare namespace IMusic {
    export type IQualityKey = "low" | "standard" | "high" | "super";
    export type IQuality = Partial<Record<IQualityKey, { url?: string; size?: string | number }>>;

    export interface IMediaSource {
        headers?: Record<string, string>;
        url?: string;
        userAgent?: string;
        quality?: IMusic.IQualityKey;
        size?: number;
    }

    export interface IMusicItemBase extends ICommon.IMediaBase {
        [k: string]: any;
    }

    export interface IMusicItem {
        id: string;
        platform: string;
        artist: string;
        title: string;
        alias?: string;
        duration: number;
        album: string;
        artwork: string;
        url?: string;
        source?: Partial<Record<IQualityKey, IMediaSource>>;
        lyric?: ILyric.ILyricSource;
        qualities?: IQuality;
        localPath?: string;
        [k: string]: any;
    }

    export interface IMusicSheetItemBase extends ICommon.IMediaBase {
        title: string;
        artwork: string;
        createAt?: number;
        description?: string;
        worksNum?: number;
        playCount?: number;
        [k: string]: any;
    }

    export interface IMusicSheetItem extends IMusicSheetItemBase {
        musicList?: IMusic.IMusicItem[];
    }

    export interface IMusicSheetGroupItem {
        title: string;
        data: IMusicSheetItemBase[];
        [k: string]: any;
    }
}

declare namespace IAlbum {
    export interface IAlbumItemBase extends ICommon.IMediaBase {
        title: string;
        artwork: string;
        date?: string;
        artist?: string;
        company?: string;
        description?: string;
        worksNum?: number;
    }

    export interface IAlbumItem extends IAlbumItemBase {
        musicList?: IMusic.IMusicItem[];
    }
}

declare namespace IArtist {
    export type ArtistMediaType = "music" | "album";
    export interface IArtistItemBase extends ICommon.IMediaBase {
        name: string;
        avatar: string;
        description?: string;
        worksNum?: number;
        [k: string]: any;
    }
    export interface IAlbumItem extends IAlbum.IAlbumItemBase {
        artist?: string;
    }
}

declare namespace ILyric {
    export interface ILyricSource {
        lrc?: string;
        rawLrc?: string;
        translation?: string;
    }

    export interface IParsedLrcItem {
        time: number;
        lrc: string;
        /** 翻译歌词（插件 getLyric 返回的 translation 按时间轴对齐后挂到行上） */
        translation?: string;
        index?: number;
    }

    export type IParsedLrc = IParsedLrcItem[];
}

declare namespace IPlugin {
    export interface IMediaSourceResult {
        headers?: Record<string, string>;
        url?: string;
        userAgent?: string;
        quality?: IMusic.IQualityKey;
        size?: number;
    }

    export interface ISearchResult<T extends ICommon.SupportMediaType> {
        isEnd?: boolean;
        data: ICommon.SupportMediaItemBase[T][];
    }
}
