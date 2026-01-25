{
    "interactionModel": {
        "languageModel": {
            "invocationName": "mood audio",
            "intents": [
                {
                    "name": "AMAZON.CancelIntent",
                    "samples": []
                },
                {
                    "name": "AMAZON.HelpIntent",
                    "samples": []
                },
                {
                    "name": "AMAZON.StopIntent",
                    "samples": []
                },
                {
                    "name": "AMAZON.NavigateHomeIntent",
                    "samples": []
                },
                {
                    "name": "AMAZON.FallbackIntent",
                    "samples": []
                },
                {
                    "name": "AMAZON.PauseIntent",
                    "samples": []
                },
                {
                    "name": "AMAZON.ResumeIntent",
                    "samples": []
                },
                {
                    "name": "PlayIntent",
                    "slots": [],
                    "samples": [
                        "play music",
                        "play"
                    ]
                },
                {
                    "name": "NextIntent",
                    "slots": [],
                    "samples": [
                        "skip this track",
                        "skip this song",
                        "next track",
                        "next song",
                        "skip",
                        "next"
                    ]
                },
                {
                    "name": "PauseIntent",
                    "slots": [],
                    "samples": [
                        "pause the queue",
                        "pause the music",
                        "pause"
                    ]
                },
                {
                    "name": "ResumeIntent",
                    "slots": [],
                    "samples": [
                        "resume mood",
                        "resume mood audio",
                        "resume the queue",
                        "resume the music",
                        "resume"
                    ]
                },
                {
                    "name": "PlayPlaylistIntent",
                    "slots": [
                        {
                            "name": "playlist",
                            "type": "AMAZON.SearchQuery"
                        }
                    ],
                    "samples": [
                        "queue the playlist {playlist}",
                        "start the playlist {playlist}",
                        "playlist {playlist}",
                        "play my playlist {playlist}",
                        "start my playlist {playlist}",
                        "start playlist {playlist}",
                        "play playlist {playlist}"
                    ]
                },
                {
                    "name": "NowPlayingIntent",
                    "slots": [],
                    "samples": [
                        "who is singing",
                        "who is this",
                        "name the song",
                        "name the track",
                        "name this track",
                        "name this song",
                        "what song is playing",
                        "what track is playing",
                        "what's this",
                        "what track is this",
                        "what's the name of this song",
                        "what's the name of this",
                        "what song is this",
                        "what's playing"
                    ]
                },
                {
                    "name": "PlayAlbumIntent",
                    "slots": [
                        {
                            "name": "album",
                            "type": "AMAZON.SearchQuery"
                        }
                    ],
                    "samples": [
                        "queue album {album}",
                        "queue the album {album}"
                    ]
                }
            ],
            "types": []
        }
    }
}